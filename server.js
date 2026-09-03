export default {
  async fetch(request, env) {
    try {
      if (!env.META_APP_ID) {
        return new Response("META_APP_ID is missing.", { status: 500 });
      }

      if (!env.META_APP_SECRET) {
        return new Response("META_APP_SECRET is missing.", { status: 500 });
      }

      if (!env.META_GRAPH_VERSION) {
        return new Response("META_GRAPH_VERSION is missing.", { status: 500 });
      }

      if (!env.DB) {
        return new Response("DB D1 binding is missing.", { status: 500 });
      }

      await ensureAccountNameColumn(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      // =========================================================
      // DASHBOARD
      // =========================================================
      if (request.method === "GET" && path === "/") {
        const accountsResult = await env.DB.prepare(`
          SELECT id, facebook_user_id, account_name, access_token, created_at
          FROM facebook_accounts
          ORDER BY id ASC
        `).all();

        const accounts = accountsResult.results || [];

        // Refresh real Facebook account names.
        for (const account of accounts) {
          await refreshStoredFacebookAccountName(
            env.DB,
            account,
            env.META_GRAPH_VERSION
          );
        }

        const pagesResult = await env.DB.prepare(`
          SELECT id, account_id, page_id, page_name
          FROM facebook_pages
          ORDER BY id ASC
        `).all();

        const pages = pagesResult.results || [];

        const pagesByAccount = {};

        for (const page of pages) {
          if (!pagesByAccount[page.account_id]) {
            pagesByAccount[page.account_id] = [];
          }

          pagesByAccount[page.account_id].push(page);
        }

        return new Response(
          dashboardHtml(accounts, pagesByAccount),
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=UTF-8",
              "cache-control":
                "no-store, no-cache, must-revalidate, proxy-revalidate",
              "pragma": "no-cache",
              "expires": "0"
            }
          }
        );
      }

      // =========================================================
      // META LOGIN
      // =========================================================
      if (request.method === "GET" && path === "/auth/meta") {
        const redirectUri =
          `${url.origin}/auth/meta/callback`;

        const scopes = [
          "pages_show_list",
          "pages_read_engagement",
          "pages_manage_posts"
        ].join(",");

        const authUrl =
          `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth` +
          `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent(scopes)}` +
          `&response_type=code`;

        return Response.redirect(authUrl, 302);
      }

      // =========================================================
      // META CALLBACK
      // =========================================================
      if (
        request.method === "GET" &&
        path === "/auth/meta/callback"
      ) {
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error");
        const oauthErrorReason =
          url.searchParams.get("error_reason");
        const oauthErrorDescription =
          url.searchParams.get("error_description");

        if (oauthError) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="error-box">
                <h2>Facebook Login Failed</h2>
                <p>${escapeHtml(
                  oauthErrorDescription ||
                  oauthErrorReason ||
                  oauthError
                )}</p>
              </div>

              <a class="btn" href="/">← Back to Dashboard</a>
            `,
            400
          );
        }

        if (!code) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="error-box">
                <h2>Missing OAuth Code</h2>
                <p>Facebook did not return an authorization code.</p>
              </div>

              <a class="btn" href="/">← Back to Dashboard</a>
            `,
            400
          );
        }

        const redirectUri =
          `${url.origin}/auth/meta/callback`;

        const tokenUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` +
          `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
          `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code=${encodeURIComponent(code)}`;

        const tokenResponse = await fetch(tokenUrl);
        const tokenData = await tokenResponse.json();

        if (
          !tokenResponse.ok ||
          tokenData.error ||
          !tokenData.access_token
        ) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="error-box">
                <h2>Could Not Get Facebook Access Token</h2>
                <pre>${escapeHtml(
                  JSON.stringify(tokenData, null, 2)
                )}</pre>
              </div>

              <a class="btn" href="/">← Back to Dashboard</a>
            `,
            500
          );
        }

        const userAccessToken =
          tokenData.access_token;

        const meData =
          await getFacebookMe(
            userAccessToken,
            env.META_GRAPH_VERSION
          );

        if (!meData || !meData.id) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="error-box">
                <h2>Could Not Read Facebook Account</h2>
                <p>
                  Meta did not return a valid Facebook account ID.
                </p>
              </div>

              <a class="btn" href="/">← Back to Dashboard</a>
            `,
            500
          );
        }

        const facebookUserId =
          String(meData.id);

        let facebookAccountName = null;

        if (meData.name) {
          const candidateName =
            String(meData.name).trim();

          if (
            candidateName &&
            !isPlaceholderAccountName(candidateName)
          ) {
            facebookAccountName =
              candidateName;
          }
        }

        if (!facebookAccountName) {
          facebookAccountName =
            facebookUserId;
        }

        const existingAccountResult =
          await env.DB.prepare(`
            SELECT id
            FROM facebook_accounts
            WHERE facebook_user_id = ?
            LIMIT 1
          `)
            .bind(facebookUserId)
            .all();

        const existingAccount =
          existingAccountResult.results?.[0] ||
          null;

        let accountId;

        if (existingAccount) {
          accountId =
            existingAccount.id;

          await env.DB.prepare(`
            UPDATE facebook_accounts
            SET account_name = ?,
                access_token = ?
            WHERE id = ?
          `)
            .bind(
              facebookAccountName,
              userAccessToken,
              accountId
            )
            .run();
        } else {
          const insertResult =
            await env.DB.prepare(`
              INSERT INTO facebook_accounts
                (facebook_user_id, account_name, access_token, created_at)
              VALUES
                (?, ?, ?, datetime('now'))
            `)
              .bind(
                facebookUserId,
                facebookAccountName,
                userAccessToken
              )
              .run();

          accountId =
            insertResult.meta.last_row_id;
        }

        const pages =
          await fetchAllFacebookPages(
            userAccessToken,
            env.META_GRAPH_VERSION
          );

        for (const page of pages) {
          if (!page.id) continue;

          const pageId =
            String(page.id);

          const pageName =
            page.name
              ? String(page.name)
              : pageId;

          const pageAccessToken =
            page.access_token
              ? String(page.access_token)
              : "";

          const existingPageResult =
            await env.DB.prepare(`
              SELECT id
              FROM facebook_pages
              WHERE account_id = ?
                AND page_id = ?
              LIMIT 1
            `)
              .bind(
                accountId,
                pageId
              )
              .all();

          const existingPage =
            existingPageResult.results?.[0] ||
            null;

          if (existingPage) {
            await env.DB.prepare(`
              UPDATE facebook_pages
              SET page_name = ?,
                  access_token = ?
              WHERE id = ?
            `)
              .bind(
                pageName,
                pageAccessToken,
                existingPage.id
              )
              .run();
          } else {
            await env.DB.prepare(`
              INSERT INTO facebook_pages
                (account_id, page_id, page_name, access_token)
              VALUES
                (?, ?, ?, ?)
            `)
              .bind(
                accountId,
                pageId,
                pageName,
                pageAccessToken
              )
              .run();
          }
        }

        return htmlResult(
          "Facebook Account Connected",
          `
            <div class="success-box">
              <h2>✅ Facebook Account Connected</h2>

              <p>
                <strong>Account:</strong>
                ${escapeHtml(facebookAccountName)}
              </p>

              <p>
                <strong>Facebook ID:</strong>
                ${escapeHtml(facebookUserId)}
              </p>

              <p>
                <strong>Pages found:</strong>
                ${pages.length}
              </p>
            </div>

            <a class="btn" href="/">← Back to Dashboard</a>
          `
        );
      }

      // =========================================================
      // SYNC PAGES
      // =========================================================
      if (
        request.method === "POST" &&
        path === "/sync-pages"
      ) {
        const formData =
          await request.formData();

        const accountId =
          formData.get("account_id");

        if (!accountId) {
          return htmlResult(
            "Sync Error",
            `
              <div class="error-box">
                <h2>Missing Account</h2>
                <p>No Facebook account was selected.</p>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        const accountResult =
          await env.DB.prepare(`
            SELECT id, facebook_user_id, account_name, access_token
            FROM facebook_accounts
            WHERE id = ?
            LIMIT 1
          `)
            .bind(accountId)
            .all();

        const account =
          accountResult.results?.[0];

        if (!account) {
          return htmlResult(
            "Sync Error",
            `
              <div class="error-box">
                <h2>Account Not Found</h2>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            404
          );
        }

        if (!account.access_token) {
          return htmlResult(
            "Sync Error",
            `
              <div class="error-box">
                <h2>Missing Access Token</h2>
                <p>Please reconnect this Facebook account.</p>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        await refreshStoredFacebookAccountName(
          env.DB,
          account,
          env.META_GRAPH_VERSION
        );

        const pages =
          await fetchAllFacebookPages(
            account.access_token,
            env.META_GRAPH_VERSION
          );

        for (const page of pages) {
          if (!page.id) continue;

          const pageId =
            String(page.id);

          const pageName =
            page.name
              ? String(page.name)
              : pageId;

          const pageAccessToken =
            page.access_token
              ? String(page.access_token)
              : "";

          const existingPageResult =
            await env.DB.prepare(`
              SELECT id
              FROM facebook_pages
              WHERE account_id = ?
                AND page_id = ?
              LIMIT 1
            `)
              .bind(
                account.id,
                pageId
              )
              .all();

          const existingPage =
            existingPageResult.results?.[0] ||
            null;

          if (existingPage) {
            await env.DB.prepare(`
              UPDATE facebook_pages
              SET page_name = ?,
                  access_token = ?
              WHERE id = ?
            `)
              .bind(
                pageName,
                pageAccessToken,
                existingPage.id
              )
              .run();
          } else {
            await env.DB.prepare(`
              INSERT INTO facebook_pages
                (account_id, page_id, page_name, access_token)
              VALUES
                (?, ?, ?, ?)
            `)
              .bind(
                account.id,
                pageId,
                pageName,
                pageAccessToken
              )
              .run();
          }
        }

        return htmlResult(
          "Pages Synced",
          `
            <div class="success-box">
              <h2>✅ Pages Synced</h2>

              <p>
                <strong>Facebook Account:</strong>
                ${escapeHtml(
                  getSafeAccountDisplayName(
                    account.account_name,
                    account.facebook_user_id
                  )
                )}
              </p>

              <p>
                <strong>Pages found:</strong>
                ${pages.length}
              </p>
            </div>

            <a class="btn" href="/">← Back to Dashboard</a>
          `
        );
      }

      // =========================================================
      // REMOVE ACCOUNT
      // =========================================================
      if (
        request.method === "POST" &&
        path === "/remove-account"
      ) {
        const formData =
          await request.formData();

        const accountId =
          formData.get("account_id");

        if (!accountId) {
          return htmlResult(
            "Remove Error",
            `
              <div class="error-box">
                <h2>Missing Account</h2>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        await env.DB.prepare(`
          DELETE FROM facebook_pages
          WHERE account_id = ?
        `)
          .bind(accountId)
          .run();

        await env.DB.prepare(`
          DELETE FROM facebook_accounts
          WHERE id = ?
        `)
          .bind(accountId)
          .run();

        return htmlResult(
          "Account Removed",
          `
            <div class="success-box">
              <h2>✅ Facebook Account Removed</h2>
              <p>
                The account and its connected Pages were removed.
              </p>
            </div>

            <a class="btn" href="/">← Back to Dashboard</a>
          `
        );
      }

      // =========================================================
      // PUBLISH
      // =========================================================
      if (
        request.method === "POST" &&
        path === "/publish"
      ) {
        const formData =
          await request.formData();

        const message =
          String(
            formData.get("message") || ""
          ).trim();

        const image =
          formData.get("image");

        const video =
          formData.get("video");

        // -------------------------------------------------------
        // Collect Page IDs from every possible submission field.
        // -------------------------------------------------------

        const rawPageIds = [
          ...formData.getAll("page_ids"),
          ...formData.getAll("selected_page_ids"),
          ...formData.getAll("page_id")
        ];

        let pageIds = [];

        for (const value of rawPageIds) {
          const stringValue =
            String(value || "").trim();

          if (!stringValue) continue;

          // Support JSON arrays if submitted.
          if (
            stringValue.startsWith("[") &&
            stringValue.endsWith("]")
          ) {
            try {
              const parsed =
                JSON.parse(stringValue);

              if (Array.isArray(parsed)) {
                pageIds.push(
                  ...parsed.map((item) =>
                    String(item || "").trim()
                  )
                );
                continue;
              }
            } catch (_) {}
          }

          // Support comma-separated IDs.
          if (stringValue.includes(",")) {
            pageIds.push(
              ...stringValue
                .split(",")
                .map((item) =>
                  String(item || "").trim()
                )
                .filter(Boolean)
            );
          } else {
            pageIds.push(stringValue);
          }
        }

        pageIds = [
          ...new Set(
            pageIds.filter(Boolean)
          )
        ];

        if (pageIds.length === 0) {
          return htmlResult(
            "Publish Error",
            `
              <div class="error-box">
                <h2>No Pages Selected</h2>

                <p>
                  Please select at least one Facebook Page.
                </p>

                <p style="color:#667085;font-size:13px;">
                  No Page ID was received by the Worker.
                </p>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        const hasImage =
          image &&
          typeof image === "object" &&
          "size" in image &&
          image.size > 0;

        const hasVideo =
          video &&
          typeof video === "object" &&
          "size" in video &&
          video.size > 0;

        if (
          !message &&
          !hasImage &&
          !hasVideo
        ) {
          return htmlResult(
            "Publish Error",
            `
              <div class="error-box">
                <h2>Nothing to Publish</h2>

                <p>
                  Enter a message or select an image/video.
                </p>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        if (
          hasImage &&
          hasVideo
        ) {
          return htmlResult(
            "Publish Error",
            `
              <div class="error-box">
                <h2>Choose One Media Type</h2>

                <p>
                  Please select either an image OR a video.
                </p>
              </div>

              <a class="btn" href="/">← Back</a>
            `,
            400
          );
        }

        const placeholders =
          pageIds
            .map(() => "?")
            .join(",");

        const pagesResult =
          await env.DB.prepare(`
            SELECT
              id,
              account_id,
              page_id,
              page_name,
              access_token
            FROM facebook_pages
            WHERE page_id IN (${placeholders})
          `)
            .bind(...pageIds)
            .all();

        const pages =
          pagesResult.results || [];

        const pageMap =
          new Map();

        for (const page of pages) {
          pageMap.set(
            String(page.page_id),
            page
          );
        }

        const results = [];

        for (const pageId of pageIds) {
          const page =
            pageMap.get(pageId);

          if (!page) {
            results.push({
              pageId,
              pageName: pageId,
              success: false,
              message:
                "Page not found in database."
            });

            continue;
          }

          if (!page.access_token) {
            results.push({
              pageId,
              pageName: page.page_name,
              success: false,
              message:
                "Page access token is missing."
            });

            continue;
          }

          try {
            let response;
            let data;

            // ---------------------------------------------------
            // VIDEO
            // ---------------------------------------------------
            if (hasVideo) {
              const publishUrl =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.page_id)}/videos`;

              const publishForm =
                new FormData();

              publishForm.append(
                "source",
                video,
                video.name || "video.mp4"
              );

              if (message) {
                publishForm.append(
                  "description",
                  message
                );
              }

              publishForm.append(
                "access_token",
                page.access_token
              );

              response =
                await fetch(
                  publishUrl,
                  {
                    method: "POST",
                    body: publishForm
                  }
                );

              data =
                await response.json();
            }

            // ---------------------------------------------------
            // IMAGE
            // ---------------------------------------------------
            else if (hasImage) {
              const publishUrl =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.page_id)}/photos`;

              const publishForm =
                new FormData();

              publishForm.append(
                "source",
                image,
                image.name || "image.jpg"
              );

              if (message) {
                publishForm.append(
                  "caption",
                  message
                );
              }

              publishForm.append(
                "access_token",
                page.access_token
              );

              response =
                await fetch(
                  publishUrl,
                  {
                    method: "POST",
                    body: publishForm
                  }
                );

              data =
                await response.json();
            }

            // ---------------------------------------------------
            // TEXT ONLY
            // ---------------------------------------------------
            else {
              const publishUrl =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.page_id)}/feed`;

              const publishParams =
                new URLSearchParams();

              publishParams.set(
                "message",
                message
              );

              publishParams.set(
                "access_token",
                page.access_token
              );

              response =
                await fetch(
                  publishUrl,
                  {
                    method: "POST",
                    headers: {
                      "content-type":
                        "application/x-www-form-urlencoded"
                    },
                    body:
                      publishParams.toString()
                  }
                );

              data =
                await response.json();
            }

            if (
              response.ok &&
              !data.error
            ) {
              results.push({
                pageId,
                pageName:
                  page.page_name,
                success: true,
                message:
                  data.id
                    ? `Published successfully. Post ID: ${data.id}`
                    : "Published successfully."
              });
            } else {
              results.push({
                pageId,
                pageName:
                  page.page_name,
                success: false,
                message:
                  data?.error?.message ||
                  "Facebook API returned an error.",
                details: data
              });
            }
          } catch (error) {
            results.push({
              pageId,
              pageName:
                page.page_name,
              success: false,
              message:
                error instanceof Error
                  ? error.message
                  : String(error)
            });
          }
        }

        return new Response(
          publishResultsPage(results),
          {
            status: 200,
            headers: {
              "content-type":
                "text/html; charset=UTF-8",
              "cache-control":
                "no-store, no-cache, must-revalidate"
            }
          }
        );
      }

      return new Response(
        "Not Found",
        {
          status: 404,
          headers: {
            "content-type":
              "text/plain; charset=UTF-8"
          }
        }
      );
    } catch (error) {
      return new Response(
        `
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Worker Error</title>

          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              background: #f5f5f5;
            }

            .box {
              max-width: 900px;
              margin: auto;
              background: white;
              padding: 30px;
              border-radius: 14px;
              box-shadow: 0 4px 20px rgba(0,0,0,.08);
            }

            pre {
              white-space: pre-wrap;
              word-break: break-word;
              background: #f3f3f3;
              padding: 15px;
              border-radius: 8px;
            }
          </style>
        </head>

        <body>
          <div class="box">
            <h1>Worker Error</h1>

            <pre>${escapeHtml(
              error instanceof Error
                ? error.stack ||
                  error.message
                : String(error)
            )}</pre>

            <p>
              <a href="/">
                Back to dashboard
              </a>
            </p>
          </div>
        </body>
        </html>
        `,
        {
          status: 500,
          headers: {
            "content-type":
              "text/html; charset=UTF-8"
          }
        }
      );
    }
  }
};


// =============================================================
// FACEBOOK HELPERS
// =============================================================

async function getFacebookMe(
  accessToken,
  graphVersion
) {
  if (!accessToken) {
    return null;
  }

  const meUrl =
    `https://graph.facebook.com/${graphVersion}/me` +
    `?fields=id,name` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const response =
    await fetch(meUrl);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.error ||
    !data.id
  ) {
    return null;
  }

  return data;
}


async function getFacebookAccountName(
  accessToken,
  graphVersion
) {
  if (!accessToken) {
    return null;
  }

  const meUrl =
    `https://graph.facebook.com/${graphVersion}/me` +
    `?fields=id,name` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const response =
    await fetch(meUrl);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.error ||
    !data.name
  ) {
    return null;
  }

  const name =
    String(data.name).trim();

  if (!name) {
    return null;
  }

  if (isPlaceholderAccountName(name)) {
    return null;
  }

  return name;
}


async function refreshStoredFacebookAccountName(
  db,
  account,
  graphVersion
) {
  if (
    !account ||
    !account.id ||
    !account.access_token
  ) {
    return null;
  }

  try {
    const realName =
      await getFacebookAccountName(
        account.access_token,
        graphVersion
      );

    if (
      realName &&
      !isPlaceholderAccountName(realName)
    ) {
      account.account_name =
        realName;

      await db.prepare(`
        UPDATE facebook_accounts
        SET account_name = ?
        WHERE id = ?
      `)
        .bind(
          realName,
          account.id
        )
        .run();

      return realName;
    }
  } catch (error) {
    // Do not break dashboard if Meta temporarily fails.
  }

  return null;
}


function isPlaceholderAccountName(name) {
  if (!name) {
    return true;
  }

  const value =
    String(name).trim();

  if (!value) {
    return true;
  }

  if (
    /^facebook\s+account\s+\d+$/i.test(value)
  ) {
    return true;
  }

  if (
    /^account\s+\d+$/i.test(value)
  ) {
    return true;
  }

  return false;
}


function getSafeAccountDisplayName(
  accountName,
  facebookUserId
) {
  if (
    accountName &&
    !isPlaceholderAccountName(accountName)
  ) {
    return String(accountName);
  }

  return String(
    facebookUserId ||
    "Facebook Account"
  );
}


// =============================================================
// FACEBOOK PAGE FETCHING
// =============================================================

async function fetchAllFacebookPages(
  userAccessToken,
  graphVersion
) {
  const allPages = [];

  let nextUrl =
    `https://graph.facebook.com/${graphVersion}/me/accounts` +
    `?fields=id,name,access_token` +
    `&limit=100` +
    `&access_token=${encodeURIComponent(userAccessToken)}`;

  while (nextUrl) {
    const response =
      await fetch(nextUrl);

    const data =
      await response.json();

    if (
      !response.ok ||
      data.error
    ) {
      throw new Error(
        data?.error?.message ||
        "Could not fetch Facebook Pages."
      );
    }

    if (
      Array.isArray(data.data)
    ) {
      allPages.push(
        ...data.data
      );
    }

    nextUrl =
      data?.paging?.next ||
      null;
  }

  return allPages;
}


// =============================================================
// D1 SCHEMA
// =============================================================

async function ensureAccountNameColumn(db) {
  const columnsResult =
    await db.prepare(
      `PRAGMA table_info(facebook_accounts)`
    ).all();

  const columns =
    columnsResult.results || [];

  const hasAccountName =
    columns.some(
      (column) =>
        column.name === "account_name"
    );

  if (!hasAccountName) {
    await db.prepare(`
      ALTER TABLE facebook_accounts
      ADD COLUMN account_name TEXT
    `).run();
  }
}


// =============================================================
// DASHBOARD HTML
// =============================================================

function dashboardHtml(
  accounts,
  pagesByAccount
) {
  const totalPages =
    Object.values(pagesByAccount)
      .reduce(
        (total, pages) =>
          total + pages.length,
        0
      );

  let accountCards = "";

  if (accounts.length === 0) {
    accountCards = `
      <div class="empty-box">
        <h2>No Facebook Accounts Connected</h2>

        <p>
          Connect your Facebook account to load its Pages.
        </p>
      </div>
    `;
  } else {
    accounts.forEach(
      (account, accountIndex) => {
        const pages =
          pagesByAccount[account.id] ||
          [];

        const accountName =
          getSafeAccountDisplayName(
            account.account_name,
            account.facebook_user_id
          );

        const accountLabel =
          `ACCOUNT ${accountIndex + 1}`;

        const pageRows =
          pages.length
            ? pages.map(
                (page) => `
                  <tr
                    class="page-row"
                    data-page-name="${escapeHtmlAttribute(
                      page.page_name
                    )}"
                    data-page-id="${escapeHtmlAttribute(
                      page.page_id
                    )}"
                  >
                    <td>
                      <input
                        type="checkbox"
                        class="page-checkbox account-${escapeHtmlAttribute(
                          account.id
                        )}"
                        name="page_ids"
                        value="${escapeHtmlAttribute(
                          page.page_id
                        )}"
                        form="publish-form"
                        data-account-id="${escapeHtmlAttribute(
                          account.id
                        )}"
                        data-page-name="${escapeHtmlAttribute(
                          page.page_name
                        )}"
                      >
                    </td>

                    <td>
                      ${escapeHtml(
                        page.page_name
                      )}
                    </td>

                    <td>
                      <code>
                        ${escapeHtml(
                          page.page_id
                        )}
                      </code>
                    </td>
                  </tr>
                `
              ).join("")
            : `
              <tr>
                <td colspan="3">
                  <div class="empty-pages">
                    No Pages connected to this account.
                  </div>
                </td>
              </tr>
            `;

        accountCards += `
          <section
            class="account-card"
            data-account-card="${escapeHtmlAttribute(
              account.id
            )}"
          >
            <div class="account-header">
              <div>
                <div class="account-label">
                  ${escapeHtml(accountLabel)}
                </div>

                <h2>
                  👤 ${escapeHtml(accountName)}
                </h2>

                <div class="account-id">
                  Facebook ID:
                  <code>
                    ${escapeHtml(
                      account.facebook_user_id
                    )}
                  </code>
                </div>

                <div class="page-count">
                  📄 ${pages.length} Pages
                </div>
              </div>

              <div class="account-actions">
                <button
                  type="button"
                  class="btn btn-select-account"
                  data-account-id="${escapeHtmlAttribute(
                    account.id
                  )}"
                >
                  ☑️ Select Account
                </button>

                <button
                  type="button"
                  class="btn btn-secondary btn-unselect-account"
                  data-account-id="${escapeHtmlAttribute(
                    account.id
                  )}"
                >
                  ⬜ Unselect
                </button>
              </div>
            </div>

            <div class="account-tools">
              <form
                method="POST"
                action="/sync-pages"
                class="inline-form"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtmlAttribute(
                    account.id
                  )}"
                >

                <button
                  type="submit"
                  class="btn btn-sync"
                >
                  🔄 Sync Pages
                </button>
              </form>

              <form
                method="POST"
                action="/remove-account"
                class="inline-form"
                onsubmit="return confirm('Remove this Facebook account and all its connected Pages?');"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtmlAttribute(
                    account.id
                  )}"
                >

                <button
                  type="submit"
                  class="btn btn-danger"
                >
                  🗑️ Remove Account
                </button>
              </form>
            </div>

            <div class="pages-title">
              📄 Pages connected with
              ${escapeHtml(accountName)}
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:70px;">
                      Select
                    </th>

                    <th>
                      Page Name
                    </th>

                    <th>
                      Page ID
                    </th>
                  </tr>
                </thead>

                <tbody>
                  ${pageRows}
                </tbody>
              </table>
            </div>
          </section>
        `;
      }
    );
  }

  return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Meta Multi Page Publisher</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
      background: #f5f7fb;
      color: #172033;
    }

    .container {
      width: min(1450px, calc(100% - 32px));
      margin: 0 auto;
      padding: 30px 0 60px;
    }

    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 25px;
    }

    .top h1 {
      margin: 0 0 8px;
      font-size: 30px;
    }

    .subtitle {
      color: #667085;
      font-size: 15px;
    }

    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .stat {
      background: white;
      border: 1px solid #e4e7ec;
      border-radius: 12px;
      padding: 15px 20px;
      box-shadow:
        0 2px 8px rgba(16, 24, 40, .04);
    }

    .stat strong {
      font-size: 22px;
      display: block;
      margin-bottom: 3px;
    }

    .stat span {
      color: #667085;
      font-size: 13px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 0;
      border-radius: 9px;
      padding: 10px 15px;
      background: #1877f2;
      color: white;
      text-decoration: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
    }

    .btn:hover {
      opacity: .9;
    }

    .btn:disabled {
      opacity: .6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: #667085;
    }

    .btn-sync {
      background: #344054;
    }

    .btn-danger {
      background: #d92d20;
    }

    .btn-publish {
      background: #1877f2;
      width: 100%;
      font-size: 16px;
      padding: 13px;
    }

    .account-card,
    .publisher {
      background: white;
      border: 1px solid #e4e7ec;
      border-radius: 15px;
      margin-bottom: 24px;
      box-shadow:
        0 4px 15px rgba(16, 24, 40, .05);
      overflow: hidden;
    }

    .account-header {
      padding: 22px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      border-bottom: 1px solid #eaecf0;
    }

    .account-label {
      color: #667085;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .7px;
      margin-bottom: 6px;
    }

    .account-header h2 {
      margin: 0 0 10px;
      font-size: 22px;
    }

    .account-id {
      color: #667085;
      font-size: 13px;
      margin-bottom: 8px;
    }

    .page-count {
      font-size: 14px;
      font-weight: 600;
    }

    code {
      background: #f2f4f7;
      border-radius: 5px;
      padding: 2px 5px;
      font-size: 12px;
    }

    .account-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .account-tools {
      display: flex;
      gap: 8px;
      padding: 15px 22px;
      background: #fafafa;
      border-bottom: 1px solid #eaecf0;
    }

    .inline-form {
      display: inline;
      margin: 0;
    }

    .pages-title {
      padding: 18px 22px;
      font-size: 15px;
      font-weight: 700;
    }

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 12px 18px;
      border-top: 1px solid #eaecf0;
      text-align: left;
      font-size: 14px;
    }

    th {
      background: #fafafa;
      color: #667085;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .4px;
    }

    tr.page-row:hover {
      background: #f8fbff;
    }

    .page-checkbox {
      width: 20px;
      height: 20px;
      cursor: pointer;
      accent-color: #1877f2;
    }

    .empty-box,
    .empty-pages {
      padding: 25px;
      color: #667085;
      text-align: center;
    }

    .publisher {
      padding: 24px;
    }

    .publisher h2 {
      margin-top: 0;
      margin-bottom: 18px;
    }

    .search-row {
      margin-bottom: 14px;
    }

    .search-row input {
      width: 100%;
    }

    .global-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }

    .field {
      margin-bottom: 18px;
    }

    label {
      display: block;
      margin-bottom: 7px;
      font-size: 14px;
      font-weight: 700;
    }

    input[type="text"],
    textarea,
    input[type="file"] {
      width: 100%;
      border: 1px solid #d0d5dd;
      border-radius: 9px;
      padding: 11px 12px;
      background: white;
      font: inherit;
    }

    textarea {
      min-height: 150px;
      resize: vertical;
    }

    .file-note {
      color: #667085;
      font-size: 12px;
      margin-top: 6px;
    }

    .connect-area {
      margin-bottom: 25px;
    }

    .account-list {
      margin-top: 5px;
    }

    .hidden {
      display: none !important;
    }

    .selected-count {
      margin: 0 0 18px;
      padding: 11px 13px;
      background: #f0f7ff;
      border: 1px solid #cfe3ff;
      border-radius: 9px;
      color: #175cd3;
      font-size: 14px;
      font-weight: 600;
    }

    @media (max-width: 800px) {
      .top,
      .account-header {
        flex-direction: column;
      }

      .account-actions {
        width: 100%;
      }

      .account-actions .btn {
        flex: 1;
      }

      .account-tools {
        flex-direction: column;
      }

      .account-tools .btn,
      .inline-form {
        width: 100%;
      }

      .account-tools .inline-form .btn {
        width: 100%;
      }

      .container {
        width: min(100% - 20px, 1450px);
        padding-top: 18px;
      }

      th,
      td {
        padding: 10px 12px;
      }

      .publisher {
        padding: 18px;
      }
    }
  </style>
</head>

<body>

  <div class="container">

    <div class="top">
      <div>
        <h1>📣 Meta Multi Page Publisher</h1>

        <div class="subtitle">
          Publish text, images or videos to multiple Facebook Pages.
        </div>
      </div>

      <div class="connect-area">
        <a
          href="/auth/meta"
          class="btn"
        >
          ➕ Connect Facebook Account
        </a>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <strong>${accounts.length}</strong>
        <span>Connected Facebook Accounts</span>
      </div>

      <div class="stat">
        <strong>${totalPages}</strong>
        <span>Connected Pages</span>
      </div>
    </div>

    <div class="account-list">

      <h2>👤 Facebook Accounts</h2>

      <p class="subtitle">
        Har Facebook account alag hai.
        Account ke Select / Unselect buttons sirf us account ke Pages ko affect karte hain.
      </p>

      ${accountCards}

    </div>

    <section class="publisher">

      <h2>📝 Create Post</h2>

      <form
        method="POST"
        action="/publish"
        enctype="multipart/form-data"
        id="publish-form"
      >

        <div
          id="selected-page-inputs"
          style="display:none;"
        ></div>

        <div
          id="selected-count"
          class="selected-count"
        >
          0 Pages Selected
        </div>

        <div class="field search-row">
          <input
            type="text"
            id="page-search"
            placeholder="🔎 Search Page Name or Page ID..."
            autocomplete="off"
          >
        </div>

        <div class="global-actions">
          <button
            type="button"
            class="btn"
            id="select-all"
          >
            ☑️ Select All
          </button>

          <button
            type="button"
            class="btn btn-secondary"
            id="unselect-all"
          >
            ⬜ Unselect All
          </button>
        </div>

        <div class="field">
          <label for="message">
            Post Message
          </label>

          <textarea
            id="message"
            name="message"
            placeholder="Write your post message..."
          ></textarea>
        </div>

        <div class="field">
          <label for="image">
            🖼️ Image
          </label>

          <input
            id="image"
            type="file"
            name="image"
            accept="image/*"
          >
        </div>

        <div class="field">
          <label for="video">
            🎥 Video
          </label>

          <input
            id="video"
            type="file"
            name="video"
            accept="video/*"
          >
        </div>

        <button
          type="submit"
          class="btn btn-publish"
          id="publish-button"
        >
          🚀 Publish to Selected Pages
        </button>

      </form>

    </section>

  </div>

  <script>
    // =========================================================
    // ELEMENTS
    // =========================================================

    const publishForm =
      document.getElementById("publish-form");

    const selectedPageInputs =
      document.getElementById("selected-page-inputs");

    const selectedCount =
      document.getElementById("selected-count");

    const imageInput =
      document.getElementById("image");

    const videoInput =
      document.getElementById("video");


    // =========================================================
    // GET ALL PAGE CHECKBOXES
    // =========================================================

    function getPageCheckboxes() {
      return Array.from(
        document.querySelectorAll(".page-checkbox")
      );
    }


    // =========================================================
    // UPDATE COUNT
    // =========================================================

    function updateSelectedCount() {
      const selected =
        getPageCheckboxes()
          .filter(
            (checkbox) =>
              checkbox.checked
          );

      if (selectedCount) {
        selectedCount.textContent =
          `${selected.length} Page${
            selected.length === 1 ? "" : "s"
          } Selected`;
      }
    }


    // =========================================================
    // CHECKBOX CHANGE
    // =========================================================

    getPageCheckboxes()
      .forEach((checkbox) => {
        checkbox.addEventListener(
          "change",
          updateSelectedCount
        );
      });


    // =========================================================
    // ACCOUNT SELECT
    // =========================================================

    document
      .querySelectorAll(".btn-select-account")
      .forEach((button) => {
        button.addEventListener(
          "click",
          () => {
            const accountId =
              button.dataset.accountId;

            getPageCheckboxes()
              .forEach((checkbox) => {
                if (
                  String(
                    checkbox.dataset.accountId
                  ) === String(accountId)
                ) {
                  checkbox.checked = true;
                }
              });

            updateSelectedCount();
          }
        );
      });


    // =========================================================
    // ACCOUNT UNSELECT
    // =========================================================

    document
      .querySelectorAll(".btn-unselect-account")
      .forEach((button) => {
        button.addEventListener(
          "click",
          () => {
            const accountId =
              button.dataset.accountId;

            getPageCheckboxes()
              .forEach((checkbox) => {
                if (
                  String(
                    checkbox.dataset.accountId
                  ) === String(accountId)
                ) {
                  checkbox.checked = false;
                }
              });

            updateSelectedCount();
          }
        );
      });


    // =========================================================
    // GLOBAL SELECT ALL
    // =========================================================

    const selectAllButton =
      document.getElementById("select-all");

    if (selectAllButton) {
      selectAllButton.addEventListener(
        "click",
        () => {
          getPageCheckboxes()
            .forEach((checkbox) => {
              const row =
                checkbox.closest(".page-row");

              if (
                !row ||
                !row.classList.contains("hidden")
              ) {
                checkbox.checked = true;
              }
            });

          updateSelectedCount();
        }
      );
    }


    // =========================================================
    // GLOBAL UNSELECT ALL
    // =========================================================

    const unselectAllButton =
      document.getElementById("unselect-all");

    if (unselectAllButton) {
      unselectAllButton.addEventListener(
        "click",
        () => {
          getPageCheckboxes()
            .forEach((checkbox) => {
              checkbox.checked = false;
            });

          updateSelectedCount();
        }
      );
    }


    // =========================================================
    // PAGE SEARCH
    // =========================================================

    const pageSearch =
      document.getElementById("page-search");

    if (pageSearch) {
      pageSearch.addEventListener(
        "input",
        () => {
          const query =
            pageSearch.value
              .trim()
              .toLowerCase();

          document
            .querySelectorAll(".page-row")
            .forEach((row) => {
              const pageName =
                (
                  row.dataset.pageName || ""
                ).toLowerCase();

              const pageId =
                (
                  row.dataset.pageId || ""
                ).toLowerCase();

              const matches =
                !query ||
                pageName.includes(query) ||
                pageId.includes(query);

              row.classList.toggle(
                "hidden",
                !matches
              );
            });
        }
      );
    }


    // =========================================================
    // IMAGE / VIDEO MUTUALLY EXCLUSIVE
    // =========================================================

    if (
      imageInput &&
      videoInput
    ) {
      imageInput.addEventListener(
        "change",
        () => {
          if (
            imageInput.files &&
            imageInput.files.length
          ) {
            videoInput.value = "";
          }
        }
      );

      videoInput.addEventListener(
        "change",
        () => {
          if (
            videoInput.files &&
            videoInput.files.length
          ) {
            imageInput.value = "";
          }
        }
      );
    }


    // =========================================================
    // PUBLISH SUBMIT
    // =========================================================
    //
    // IMPORTANT FIX:
    //
    // The Page checkboxes are outside the publish form.
    //
    // Each checkbox now has:
    //
    //     form="publish-form"
    //
    // Therefore the browser itself submits checked Page IDs.
    //
    // We ALSO create hidden page_ids inputs as a second
    // fallback. This gives us two ways to send Page IDs.
    // =========================================================

    if (publishForm) {
      publishForm.addEventListener(
        "submit",
        (event) => {
          const selected =
            getPageCheckboxes()
              .filter(
                (checkbox) =>
                  checkbox.checked
              );

          const message =
            document
              .getElementById("message")
              ?.value
              .trim() || "";

          const hasImage =
            imageInput &&
            imageInput.files &&
            imageInput.files.length > 0;

          const hasVideo =
            videoInput &&
            videoInput.files &&
            videoInput.files.length > 0;


          // ---------------------------------------------------
          // Selected pages validation
          // ---------------------------------------------------

          if (!selected.length) {
            event.preventDefault();

            updateSelectedCount();

            alert(
              "Please select at least one Facebook Page."
            );

            return;
          }


          // ---------------------------------------------------
          // Content validation
          // ---------------------------------------------------

          if (
            !message &&
            !hasImage &&
            !hasVideo
          ) {
            event.preventDefault();

            alert(
              "Please enter a message or select an image/video."
            );

            return;
          }


          // ---------------------------------------------------
          // Media validation
          // ---------------------------------------------------

          if (
            hasImage &&
            hasVideo
          ) {
            event.preventDefault();

            alert(
              "Please select either an image OR a video."
            );

            return;
          }


          // ---------------------------------------------------
          // Create backup hidden Page ID fields.
          // ---------------------------------------------------

          if (selectedPageInputs) {
            selectedPageInputs.innerHTML = "";

            selected.forEach(
              (checkbox) => {
                const hidden =
                  document.createElement("input");

                hidden.type = "hidden";
                hidden.name = "selected_page_ids";
                hidden.value = checkbox.value;

                selectedPageInputs.appendChild(
                  hidden
                );
              }
            );
          }


          // ---------------------------------------------------
          // Do NOT disable checkboxes.
          //
          // Because they now have form="publish-form",
          // the browser itself will submit them normally.
          // ---------------------------------------------------

          const button =
            document.getElementById(
              "publish-button"
            );

          if (button) {
            button.disabled = true;
            button.textContent =
              "⏳ Publishing...";
          }

          // Allow normal multipart form submission.
        }
      );
    }


    // =========================================================
    // INITIAL COUNT
    // =========================================================

    updateSelectedCount();
  </script>

</body>
</html>
  `;
}


// =============================================================
// PUBLISH RESULTS
// =============================================================

function publishResultsPage(
  results
) {
  const successful =
    results.filter(
      (result) =>
        result.success
    ).length;

  const failed =
    results.length -
    successful;

  const rows =
    results.map(
      (result) => `
        <tr>
          <td>
            ${
              result.success
                ? "✅"
                : "❌"
            }
          </td>

          <td>
            ${escapeHtml(
              result.pageName
            )}
          </td>

          <td>
            <code>
              ${escapeHtml(
                result.pageId
              )}
            </code>
          </td>

          <td>
            ${escapeHtml(
              result.message || ""
            )}
          </td>
        </tr>
      `
    ).join("");

  return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Publish Results</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
      background: #f5f7fb;
      color: #172033;
    }

    .container {
      width: min(
        1200px,
        calc(100% - 30px)
      );
      margin: 40px auto;
    }

    .box {
      background: white;
      border: 1px solid #e4e7ec;
      border-radius: 15px;
      padding: 25px;
      box-shadow:
        0 4px 15px rgba(16, 24, 40, .05);
    }

    .stats {
      display: flex;
      gap: 15px;
      margin: 20px 0;
      flex-wrap: wrap;
    }

    .stat {
      padding: 15px 20px;
      border: 1px solid #e4e7ec;
      border-radius: 10px;
      background: #fafafa;
    }

    .stat strong {
      display: block;
      font-size: 22px;
    }

    .stat span {
      color: #667085;
      font-size: 13px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 13px;
      border-top: 1px solid #eaecf0;
      text-align: left;
    }

    th {
      background: #fafafa;
      color: #667085;
      font-size: 12px;
      text-transform: uppercase;
    }

    .btn {
      display: inline-block;
      background: #1877f2;
      color: white;
      text-decoration: none;
      border-radius: 9px;
      padding: 11px 16px;
      font-weight: 600;
      margin-top: 20px;
    }

    code {
      background: #f2f4f7;
      padding: 3px 5px;
      border-radius: 5px;
      font-size: 12px;
    }

    @media (max-width: 700px) {
      .container {
        width: calc(100% - 20px);
        margin: 15px auto;
      }

      .box {
        padding: 16px;
        overflow-x: auto;
      }

      table {
        min-width: 700px;
      }
    }
  </style>
</head>

<body>

  <div class="container">

    <div class="box">

      <h1>🚀 Publish Results</h1>

      <div class="stats">
        <div class="stat">
          <strong>
            ${results.length}
          </strong>

          <span>
            Total Pages
          </span>
        </div>

        <div class="stat">
          <strong>
            ${successful}
          </strong>

          <span>
            Successful
          </span>
        </div>

        <div class="stat">
          <strong>
            ${failed}
          </strong>

          <span>
            Failed
          </span>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Page</th>
            <th>Page ID</th>
            <th>Result</th>
          </tr>
        </thead>

        <tbody>
          ${rows}
        </tbody>
      </table>

      <a
        href="/"
        class="btn"
      >
        ← Back to Dashboard
      </a>

    </div>

  </div>

</body>
</html>
  `;
}


// =============================================================
// SIMPLE RESULT PAGE
// =============================================================

function htmlResult(
  title,
  content,
  status = 200
) {
  return new Response(
    `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>
    ${escapeHtml(title)}
  </title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 30px;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
      background: #f5f7fb;
      color: #172033;
    }

    .box {
      max-width: 900px;
      margin: 30px auto;
      background: white;
      border: 1px solid #e4e7ec;
      border-radius: 15px;
      padding: 30px;
      box-shadow:
        0 4px 15px rgba(16, 24, 40, .05);
    }

    .success-box {
      padding: 20px;
      border-radius: 10px;
      background: #ecfdf3;
      border: 1px solid #abefc6;
      margin-bottom: 20px;
    }

    .error-box {
      padding: 20px;
      border-radius: 10px;
      background: #fef3f2;
      border: 1px solid #fecdca;
      margin-bottom: 20px;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f2f4f7;
      padding: 15px;
      border-radius: 8px;
      overflow-x: auto;
    }

    .btn {
      display: inline-block;
      background: #1877f2;
      color: white;
      text-decoration: none;
      border-radius: 9px;
      padding: 11px 16px;
      font-weight: 600;
    }
  </style>
</head>

<body>

  <div class="box">

    <h1>
      ${escapeHtml(title)}
    </h1>

    ${content}

  </div>

</body>
</html>
    `,
    {
      status,
      headers: {
        "content-type":
          "text/html; charset=UTF-8",

        "cache-control":
          "no-store, no-cache, must-revalidate"
      }
    }
  );
}


// =============================================================
// HTML ESCAPING
// =============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}
