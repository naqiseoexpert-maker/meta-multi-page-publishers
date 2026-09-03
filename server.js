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

      const url = new URL(request.url);
      const path = url.pathname;

      // =========================================================
      // DASHBOARD
      // =========================================================
      if (request.method === "GET" && path === "/") {
        const accountsResult = await env.DB.prepare(`
          SELECT id, facebook_user_id, created_at
          FROM facebook_accounts
          ORDER BY id DESC
        `).all();

        const pagesResult = await env.DB.prepare(`
          SELECT id, account_id, page_id, page_name
          FROM facebook_pages
          ORDER BY page_name COLLATE NOCASE ASC
        `).all();

        const accounts = accountsResult.results || [];
        const pages = pagesResult.results || [];

        const pagesByAccount = {};

        for (const page of pages) {
          if (!pagesByAccount[page.account_id]) {
            pagesByAccount[page.account_id] = [];
          }

          pagesByAccount[page.account_id].push(page);
        }

        const accountCards = accounts.map((account) => {
          const accountPages = pagesByAccount[account.id] || [];

          return `
            <div class="account-card">

              <div class="account-header">

                <div>
                  <h3>
                    Facebook Account
                    <span class="account-id">
                      ID: ${escapeHtml(account.facebook_user_id)}
                    </span>
                  </h3>

                  <div class="account-pages-count">
                    ${accountPages.length}
                    Page${accountPages.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="account-actions">

                  <button
                    type="button"
                    class="btn btn-blue account-select-btn"
                    data-account-id="${escapeHtml(String(account.id))}">
                    ☑️ Select Account
                  </button>

                  <button
                    type="button"
                    class="btn btn-gray account-unselect-btn"
                    data-account-id="${escapeHtml(String(account.id))}">
                    ⬜ Unselect
                  </button>

                  <form
                    method="POST"
                    action="/sync-pages"
                    class="action-form">

                    <input
                      type="hidden"
                      name="account_id"
                      value="${escapeHtml(String(account.id))}">

                    <button
                      type="submit"
                      class="btn btn-orange">
                      🔄 Sync Pages
                    </button>

                  </form>

                  <form
                    method="POST"
                    action="/remove-account"
                    class="action-form"
                    onsubmit="return confirmRemoveAccount();">

                    <input
                      type="hidden"
                      name="account_id"
                      value="${escapeHtml(String(account.id))}">

                    <button
                      type="submit"
                      class="btn btn-red">
                      🗑️ Remove Account
                    </button>

                  </form>

                </div>

              </div>

              ${
                accountPages.length
                  ? `
                    <div class="account-page-table-wrap">

                      <table class="page-table">

                        <thead>
                          <tr>
                            <th style="width:70px;">Select</th>
                            <th>Page Name</th>
                            <th>Page ID</th>
                          </tr>
                        </thead>

                        <tbody>

                          ${accountPages.map((page) => `
                            <tr
                              class="page-row"
                              data-page-name="${escapeHtml(page.page_name || "")}"
                              data-page-id="${escapeHtml(page.page_id || "")}">

                              <td>
                                <input
                                  type="checkbox"
                                  class="page-checkbox account-${escapeHtml(String(account.id))}"
                                  value="${escapeHtml(String(page.page_id))}"
                                  data-account-id="${escapeHtml(String(account.id))}">
                              </td>

                              <td class="page-name">
                                ${escapeHtml(page.page_name || "")}
                              </td>

                              <td class="page-id">
                                ${escapeHtml(page.page_id || "")}
                              </td>

                            </tr>
                          `).join("")}

                        </tbody>

                      </table>

                    </div>
                  `
                  : `
                    <div class="no-pages">
                      No Pages found for this Facebook account.
                      Click <b>🔄 Sync Pages</b> after adding Pages to this account.
                    </div>
                  `
              }

            </div>
          `;
        }).join("");

        return new Response(
          dashboardHtml({
            accountCards,
            totalAccounts: accounts.length,
            totalPages: pages.length
          }),
          {
            headers: {
              "content-type": "text/html; charset=UTF-8",
              "cache-control": "no-store"
            }
          }
        );
      }

      // =========================================================
      // FACEBOOK LOGIN
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
          `&scope=${encodeURIComponent(scopes)}`;

        return Response.redirect(authUrl, 302);
      }

      // =========================================================
      // FACEBOOK CALLBACK
      // =========================================================
      if (
        request.method === "GET" &&
        path === "/auth/meta/callback"
      ) {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDescription =
          url.searchParams.get("error_description");

        if (error) {
          return htmlResult(
            "Facebook Login Error",
            `
              <p><b>Error:</b> ${escapeHtml(error)}</p>

              <p>
                ${escapeHtml(
                  errorDescription ||
                  "Facebook Login failed."
                )}
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        if (!code) {
          return htmlResult(
            "Facebook Login Error",
            `
              <p>
                Facebook did not return an authorization code.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
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
          !tokenData.access_token
        ) {
          return htmlResult(
            "Facebook Token Error",
            `
              <p>
                Could not get Facebook access token.
              </p>

              <pre>${escapeHtml(
                JSON.stringify(tokenData, null, 2)
              )}</pre>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const userAccessToken =
          tokenData.access_token;

        // =====================================================
        // GET FACEBOOK USER ID
        // =====================================================
        const meUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me` +
          `?fields=id` +
          `&access_token=${encodeURIComponent(userAccessToken)}`;

        const meResponse = await fetch(meUrl);
        const meData = await meResponse.json();

        if (
          !meResponse.ok ||
          !meData.id
        ) {
          return htmlResult(
            "Facebook User Error",
            `
              <p>
                Could not identify the Facebook account.
              </p>

              <pre>${escapeHtml(
                JSON.stringify(meData, null, 2)
              )}</pre>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const facebookUserId =
          String(meData.id);

        // =====================================================
        // SAVE / UPDATE FACEBOOK ACCOUNT
        // =====================================================
        let account =
          await env.DB.prepare(`
            SELECT
              id,
              facebook_user_id,
              access_token
            FROM facebook_accounts
            WHERE facebook_user_id = ?
            LIMIT 1
          `)
            .bind(facebookUserId)
            .first();

        let accountId;

        if (account) {
          await env.DB.prepare(`
            UPDATE facebook_accounts
            SET access_token = ?
            WHERE id = ?
          `)
            .bind(
              userAccessToken,
              account.id
            )
            .run();

          accountId = account.id;
        } else {
          const insertResult =
            await env.DB.prepare(`
              INSERT INTO facebook_accounts
                (
                  facebook_user_id,
                  access_token
                )
              VALUES (?, ?)
            `)
              .bind(
                facebookUserId,
                userAccessToken
              )
              .run();

          accountId =
            insertResult.meta?.last_row_id;

          if (!accountId) {
            const newAccount =
              await env.DB.prepare(`
                SELECT id
                FROM facebook_accounts
                WHERE facebook_user_id = ?
                LIMIT 1
              `)
                .bind(facebookUserId)
                .first();

            if (!newAccount) {
              return htmlResult(
                "Database Error",
                `
                  <p>
                    Facebook account could not be saved.
                  </p>

                  <p>
                    <a href="/">
                      ← Back to Dashboard
                    </a>
                  </p>
                `
              );
            }

            accountId = newAccount.id;
          }
        }

        // =====================================================
        // GET FACEBOOK PAGES
        // =====================================================
        let accountsUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
          `?fields=id,name,access_token&limit=100` +
          `&access_token=${encodeURIComponent(userAccessToken)}`;

        let pageCount = 0;
        let newPages = 0;
        let updatedPages = 0;

        while (accountsUrl) {
          const pagesResponse =
            await fetch(accountsUrl);

          const pagesData =
            await pagesResponse.json();

          if (
            !pagesResponse.ok ||
            pagesData.error
          ) {
            return htmlResult(
              "Facebook Pages Error",
              `
                <h2>❌ Facebook Pages Error</h2>

                <p>
                  Facebook account was connected,
                  but Pages could not be fetched.
                </p>

                <pre>${escapeHtml(
                  JSON.stringify(
                    pagesData,
                    null,
                    2
                  )
                )}</pre>

                <p>
                  <a href="/">
                    ← Back to Dashboard
                  </a>
                </p>
              `
            );
          }

          for (const page of pagesData.data || []) {
            if (
              !page.id ||
              !page.access_token
            ) {
              continue;
            }

            pageCount++;

            const existingPage =
              await env.DB.prepare(`
                SELECT id
                FROM facebook_pages
                WHERE account_id = ?
                  AND page_id = ?
                LIMIT 1
              `)
                .bind(
                  accountId,
                  String(page.id)
                )
                .first();

            if (existingPage) {
              await env.DB.prepare(`
                UPDATE facebook_pages
                SET
                  page_name = ?,
                  page_access_token = ?
                WHERE id = ?
              `)
                .bind(
                  page.name || "",
                  page.access_token,
                  existingPage.id
                )
                .run();

              updatedPages++;
            } else {
              await env.DB.prepare(`
                INSERT INTO facebook_pages
                  (
                    account_id,
                    page_id,
                    page_name,
                    page_access_token
                  )
                VALUES (?, ?, ?, ?)
              `)
                .bind(
                  accountId,
                  String(page.id),
                  page.name || "",
                  page.access_token
                )
                .run();

              newPages++;
            }
          }

          accountsUrl =
            pagesData.paging?.next || null;
        }

        return htmlResult(
          "Facebook Account Connected",
          `
            <div class="success-box">

              <h2>
                ✅ Facebook Account Connected
              </h2>

              <p>
                Facebook User ID:
                <b>${escapeHtml(facebookUserId)}</b>
              </p>

              <p>
                Pages found:
                <b>${pageCount}</b>
              </p>

              <p>
                New Pages:
                <b>${newPages}</b>
              </p>

              <p>
                Updated Pages:
                <b>${updatedPages}</b>
              </p>

            </div>

            <p>
              <a class="main-link" href="/">
                ← Back to Dashboard
              </a>
            </p>
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
          String(formData.get("account_id") || "").trim();

        if (!accountId) {
          return htmlResult(
            "Sync Error",
            `
              <p>
                Facebook account ID is missing.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const account =
          await env.DB.prepare(`
            SELECT
              id,
              facebook_user_id,
              access_token
            FROM facebook_accounts
            WHERE id = ?
            LIMIT 1
          `)
            .bind(accountId)
            .first();

        if (!account) {
          return htmlResult(
            "Sync Error",
            `
              <p>
                Facebook account was not found.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        if (!account.access_token) {
          return htmlResult(
            "Sync Error",
            `
              <p>
                This account does not have a saved access token.
              </p>

              <p>
                <a href="/auth/meta">
                  Reconnect Facebook
                </a>
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        let accountsUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
          `?fields=id,name,access_token&limit=100` +
          `&access_token=${encodeURIComponent(account.access_token)}`;

        let found = 0;
        let saved = 0;
        let newPages = 0;
        let updatedPages = 0;

        try {
          while (accountsUrl) {
            const response =
              await fetch(accountsUrl);

            const data =
              await response.json();

            if (
              !response.ok ||
              data.error
            ) {
              return htmlResult(
                "Sync Error",
                `
                  <h2>
                    ❌ Facebook Page Sync Failed
                  </h2>

                  <pre>${escapeHtml(
                    JSON.stringify(
                      data,
                      null,
                      2
                    )
                  )}</pre>

                  <p>
                    <a href="/auth/meta">
                      Reconnect Facebook
                    </a>
                  </p>

                  <p>
                    <a href="/">
                      ← Back to Dashboard
                    </a>
                  </p>
                `
              );
            }

            for (const page of data.data || []) {
              if (
                !page.id ||
                !page.access_token
              ) {
                continue;
              }

              found++;

              const existing =
                await env.DB.prepare(`
                  SELECT id
                  FROM facebook_pages
                  WHERE account_id = ?
                    AND page_id = ?
                  LIMIT 1
                `)
                  .bind(
                    account.id,
                    String(page.id)
                  )
                  .first();

              if (existing) {
                await env.DB.prepare(`
                  UPDATE facebook_pages
                  SET
                    page_name = ?,
                    page_access_token = ?
                  WHERE id = ?
                `)
                  .bind(
                    page.name || "",
                    page.access_token,
                    existing.id
                  )
                  .run();

                updatedPages++;
              } else {
                await env.DB.prepare(`
                  INSERT INTO facebook_pages
                    (
                      account_id,
                      page_id,
                      page_name,
                      page_access_token
                    )
                  VALUES (?, ?, ?, ?)
                `)
                  .bind(
                    account.id,
                    String(page.id),
                    page.name || "",
                    page.access_token
                  )
                  .run();

                newPages++;
              }

              saved++;
            }

            accountsUrl =
              data.paging?.next || null;
          }
        } catch (error) {
          return htmlResult(
            "Sync Error",
            `
              <h2>❌ Sync Failed</h2>

              <p>
                ${escapeHtml(
                  error?.message ||
                  String(error)
                )}
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        return htmlResult(
          "Pages Synced",
          `
            <div class="success-box">

              <h2>
                ✅ Pages Synced Successfully
              </h2>

              <p>
                Facebook Account:
                <b>
                  ${escapeHtml(account.facebook_user_id)}
                </b>
              </p>

              <p>
                Pages Found:
                <b>${found}</b>
              </p>

              <p>
                New Pages:
                <b>${newPages}</b>
              </p>

              <p>
                Updated Pages:
                <b>${updatedPages}</b>
              </p>

              <p>
                Saved:
                <b>${saved}</b>
              </p>

            </div>

            <p>
              <a class="main-link" href="/">
                ← Back to Dashboard
              </a>
            </p>
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
          String(formData.get("account_id") || "").trim();

        if (!accountId) {
          return htmlResult(
            "Remove Account Error",
            `
              <p>
                Account ID is missing.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const account =
          await env.DB.prepare(`
            SELECT
              id,
              facebook_user_id
            FROM facebook_accounts
            WHERE id = ?
            LIMIT 1
          `)
            .bind(accountId)
            .first();

        if (!account) {
          return htmlResult(
            "Remove Account Error",
            `
              <p>
                Facebook account was not found.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        await env.DB.prepare(`
          DELETE FROM facebook_pages
          WHERE account_id = ?
        `)
          .bind(account.id)
          .run();

        await env.DB.prepare(`
          DELETE FROM facebook_accounts
          WHERE id = ?
        `)
          .bind(account.id)
          .run();

        return htmlResult(
          "Account Removed",
          `
            <div class="success-box">

              <h2>
                ✅ Facebook Account Removed
              </h2>

              <p>
                Facebook User ID:
                <b>
                  ${escapeHtml(account.facebook_user_id)}
                </b>
              </p>

              <p>
                Account and its saved Pages
                were removed from this publisher.
              </p>

              <p>
                This does not delete the Facebook account itself.
              </p>

            </div>

            <p>
              <a class="main-link" href="/">
                ← Back to Dashboard
              </a>
            </p>
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

        const pageIds =
          formData
            .getAll("page_ids")
            .map((id) => String(id))
            .filter(Boolean);

        const image =
          formData.get("image");

        const video =
          formData.get("video");

        const hasImage =
          image &&
          typeof image === "object" &&
          typeof image.arrayBuffer === "function" &&
          image.size > 0;

        const hasVideo =
          video &&
          typeof video === "object" &&
          typeof video.arrayBuffer === "function" &&
          video.size > 0;

        if (pageIds.length === 0) {
          return htmlResult(
            "Publish Error",
            `
              <p>
                Please select at least one Facebook Page.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        if (
          !message &&
          !hasImage &&
          !hasVideo
        ) {
          return htmlResult(
            "Publish Error",
            `
              <p>
                Please enter a message
                or select an image/video.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        if (
          hasImage &&
          hasVideo
        ) {
          return htmlResult(
            "Publish Error",
            `
              <p>
                Please select either an image
                OR a video, not both.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const placeholders =
          pageIds.map(() => "?").join(",");

        const selectedPagesResult =
          await env.DB.prepare(`
            SELECT
              id,
              account_id,
              page_id,
              page_name,
              page_access_token
            FROM facebook_pages
            WHERE page_id IN (${placeholders})
            ORDER BY page_name COLLATE NOCASE ASC
          `)
            .bind(...pageIds)
            .all();

        const selectedPages =
          selectedPagesResult.results || [];

        if (selectedPages.length === 0) {
          return htmlResult(
            "Publish Error",
            `
              <p>
                None of the selected Pages
                were found in the database.
              </p>

              <p>
                Please sync your Facebook account first.
              </p>

              <p>
                <a href="/">← Back to Dashboard</a>
              </p>
            `
          );
        }

        const results = [];

        let imageBuffer = null;
        let videoBuffer = null;

        if (hasImage) {
          imageBuffer =
            await image.arrayBuffer();
        }

        if (hasVideo) {
          videoBuffer =
            await video.arrayBuffer();
        }

        for (const page of selectedPages) {
          try {
            if (!page.page_access_token) {
              results.push({
                pageName: page.page_name,
                pageId: page.page_id,
                success: false,
                error:
                  "Page access token is missing."
              });

              continue;
            }

            let response;

            if (hasVideo) {
              const endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/videos`;

              const body =
                new FormData();

              if (message) {
                body.append(
                  "description",
                  message
                );
              }

              const videoBlob =
                new Blob(
                  [videoBuffer],
                  {
                    type:
                      video.type ||
                      "video/mp4"
                  }
                );

              body.append(
                "source",
                videoBlob,
                video.name || "video.mp4"
              );

              body.append(
                "access_token",
                page.page_access_token
              );

              response =
                await fetch(
                  endpoint,
                  {
                    method: "POST",
                    body
                  }
                );
            } else if (hasImage) {
              const endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/photos`;

              const body =
                new FormData();

              if (message) {
                body.append(
                  "caption",
                  message
                );
              }

              const imageBlob =
                new Blob(
                  [imageBuffer],
                  {
                    type:
                      image.type ||
                      "image/jpeg"
                  }
                );

              body.append(
                "source",
                imageBlob,
                image.name || "image.jpg"
              );

              body.append(
                "access_token",
                page.page_access_token
              );

              response =
                await fetch(
                  endpoint,
                  {
                    method: "POST",
                    body
                  }
                );
            } else {
              const endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/feed`;

              const body =
                new URLSearchParams();

              body.set(
                "message",
                message
              );

              body.set(
                "access_token",
                page.page_access_token
              );

              response =
                await fetch(
                  endpoint,
                  {
                    method: "POST",
                    headers: {
                      "content-type":
                        "application/x-www-form-urlencoded"
                    },
                    body
                  }
                );
            }

            const data =
              await response.json();

            if (
              !response.ok ||
              data.error
            ) {
              results.push({
                pageName: page.page_name,
                pageId: page.page_id,
                success: false,
                error:
                  data?.error?.message ||
                  `Facebook API error (HTTP ${response.status})`
              });
            } else {
              results.push({
                pageName: page.page_name,
                pageId: page.page_id,
                success: true,
                postId:
                  data.id ||
                  data.post_id ||
                  "Published"
              });
            }
          } catch (error) {
            results.push({
              pageName: page.page_name,
              pageId: page.page_id,
              success: false,
              error:
                error?.message ||
                String(error)
            });
          }
        }

        return publishResultsPage(
          results,
          message,
          hasImage,
          hasVideo
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
          <!DOCTYPE html>
          <html>

          <head>
            <meta charset="UTF-8">
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
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0,0,0,.08);
              }

              pre {
                white-space: pre-wrap;
                word-break: break-word;
                background: #f1f1f1;
                padding: 15px;
                border-radius: 8px;
              }

              a {
                color: #1877f2;
              }
            </style>
          </head>

          <body>

            <div class="box">

              <h2>❌ Worker Error</h2>

              <pre>${escapeHtml(
                error?.stack ||
                error?.message ||
                String(error)
              )}</pre>

              <p>
                <a href="/">← Back to Dashboard</a>
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
// DASHBOARD HTML
// =============================================================

function dashboardHtml({
  accountCards,
  totalAccounts,
  totalPages
}) {
  return `
<!DOCTYPE html>

<html>

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0">

  <title>
    Meta Multi Page Publisher
  </title>

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #f4f7fb;
      color: #172033;
    }

    .container {
      max-width: 1250px;
      margin: 0 auto;
      padding: 25px;
    }

    .topbar {
      background: white;
      border-radius: 14px;
      padding: 22px;
      margin-bottom: 20px;
      box-shadow: 0 4px 18px rgba(0,0,0,.06);
    }

    .topbar h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }

    .subtitle {
      color: #687386;
      margin-bottom: 18px;
    }

    .stats {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
    }

    .stat {
      background: #f4f7fb;
      border-radius: 10px;
      padding: 12px 18px;
      min-width: 160px;
    }

    .stat strong {
      display: block;
      font-size: 22px;
      margin-bottom: 4px;
    }

    .connect-btn {
      display: inline-block;
      text-decoration: none;
      background: #1877f2;
      color: white;
      padding: 12px 18px;
      border-radius: 8px;
      font-weight: bold;
      margin-top: 18px;
    }

    .account-card {
      background: white;
      border-radius: 14px;
      margin-bottom: 20px;
      overflow: hidden;
      box-shadow: 0 4px 18px rgba(0,0,0,.06);
    }

    .account-header {
      padding: 20px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: center;
      border-bottom: 1px solid #edf0f5;
    }

    .account-header h3 {
      margin: 0 0 7px;
      font-size: 19px;
    }

    .account-id {
      color: #6d7788;
      font-size: 13px;
      font-weight: normal;
      margin-left: 7px;
    }

    .account-pages-count {
      color: #687386;
      font-size: 14px;
    }

    .account-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
    }

    .action-form {
      margin: 0;
      padding: 0;
      display: inline-block;
    }

    .btn {
      border: 0;
      border-radius: 7px;
      padding: 9px 12px;
      cursor: pointer;
      font-weight: bold;
      font-size: 13px;
    }

    .btn:hover {
      opacity: .88;
    }

    .btn:disabled {
      opacity: .6;
      cursor: wait;
    }

    .btn-blue {
      background: #1877f2;
      color: white;
    }

    .btn-gray {
      background: #e9edf3;
      color: #293244;
    }

    .btn-orange {
      background: #f59e0b;
      color: white;
    }

    .btn-red {
      background: #dc2626;
      color: white;
    }

    .account-page-table-wrap {
      overflow-x: auto;
    }

    .page-table {
      width: 100%;
      border-collapse: collapse;
    }

    .page-table th,
    .page-table td {
      padding: 13px 16px;
      border-bottom: 1px solid #edf0f5;
      text-align: left;
    }

    .page-table th {
      background: #fafbfc;
      font-size: 13px;
      color: #667085;
    }

    .page-name {
      font-weight: 600;
    }

    .page-id {
      color: #687386;
      font-family: monospace;
      font-size: 13px;
    }

    .no-pages {
      padding: 25px;
      color: #687386;
      background: #fafbfc;
    }

    .publisher-card {
      background: white;
      border-radius: 14px;
      padding: 22px;
      margin-top: 25px;
      box-shadow: 0 4px 18px rgba(0,0,0,.06);
    }

    .publisher-card h2 {
      margin-top: 0;
    }

    .search-box {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #d8dee8;
      border-radius: 8px;
      font-size: 15px;
      margin-bottom: 15px;
      outline: none;
    }

    .search-box:focus {
      border-color: #1877f2;
    }

    .selection-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 15px;
    }

    .small-btn {
      padding: 8px 12px;
      border: 1px solid #d8dee8;
      background: white;
      border-radius: 7px;
      cursor: pointer;
      font-weight: 600;
    }

    .small-btn:hover {
      background: #f4f7fb;
    }

    .message-label {
      display: block;
      font-weight: bold;
      margin-bottom: 7px;
    }

    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      border: 1px solid #d8dee8;
      border-radius: 9px;
      padding: 13px;
      font-family: inherit;
      font-size: 15px;
      outline: none;
    }

    textarea:focus {
      border-color: #1877f2;
    }

    .upload-row {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      margin-top: 15px;
    }

    .upload-box {
      flex: 1;
      min-width: 250px;
      border: 1px dashed #cbd3df;
      border-radius: 9px;
      padding: 15px;
      background: #fafbfc;
    }

    .upload-box label {
      display: block;
      font-weight: bold;
      margin-bottom: 8px;
    }

    input[type="file"] {
      width: 100%;
    }

    .publish-btn {
      width: 100%;
      margin-top: 20px;
      padding: 14px;
      border: 0;
      border-radius: 9px;
      background: #1877f2;
      color: white;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    .publish-btn:hover {
      opacity: .9;
    }

    .empty {
      background: white;
      padding: 35px;
      border-radius: 14px;
      text-align: center;
      box-shadow: 0 4px 18px rgba(0,0,0,.06);
    }

    .success-box {
      background: #ecfdf3;
      border: 1px solid #a7f3d0;
      padding: 20px;
      border-radius: 10px;
    }

    .main-link {
      color: #1877f2;
      text-decoration: none;
      font-weight: bold;
    }

    @media (max-width: 800px) {

      .container {
        padding: 12px;
      }

      .account-header {
        flex-direction: column;
        align-items: flex-start;
      }

      .account-actions {
        justify-content: flex-start;
      }

      .account-id {
        display: block;
        margin-left: 0;
        margin-top: 5px;
      }

    }

  </style>

</head>

<body>

  <div class="container">

    <div class="topbar">

      <h1>
        📣 Meta Multi Page Publisher
      </h1>

      <div class="subtitle">
        Publish text, images or videos to multiple Facebook Pages.
      </div>

      <div class="stats">

        <div class="stat">
          <strong>${totalAccounts}</strong>
          Connected Facebook Account${totalAccounts === 1 ? "" : "s"}
        </div>

        <div class="stat">
          <strong>${totalPages}</strong>
          Connected Page${totalPages === 1 ? "" : "s"}
        </div>

      </div>

      <a
        class="connect-btn"
        href="/auth/meta">
        ➕ Connect Facebook Account
      </a>

    </div>

    ${
      accountCards
        ? accountCards
        : `
          <div class="empty">

            <h2>
              No Facebook Accounts Connected
            </h2>

            <p>
              Connect a Facebook account to load its Pages.
            </p>

            <a
              class="connect-btn"
              href="/auth/meta">
              Connect Facebook
            </a>

          </div>
        `
    }

    ${
      totalAccounts > 0
        ? `
          <div class="publisher-card">

            <h2>
              📝 Create Post
            </h2>

            <form
              method="POST"
              action="/publish"
              enctype="multipart/form-data"
              id="publishForm">

              <input
                type="text"
                class="search-box"
                id="pageSearch"
                placeholder="🔎 Search Page Name or Page ID...">

              <div class="selection-buttons">

                <button
                  type="button"
                  class="small-btn"
                  id="selectAllPagesButton">
                  ☑️ Select All
                </button>

                <button
                  type="button"
                  class="small-btn"
                  id="unselectAllPagesButton">
                  ⬜ Unselect All
                </button>

              </div>

              <label class="message-label">
                Post Message
              </label>

              <textarea
                name="message"
                id="message"
                placeholder="Write your Facebook post here..."></textarea>

              <div class="upload-row">

                <div class="upload-box">

                  <label>
                    🖼️ Image
                  </label>

                  <input
                    type="file"
                    name="image"
                    id="image"
                    accept="image/*">

                </div>

                <div class="upload-box">

                  <label>
                    🎥 Video
                  </label>

                  <input
                    type="file"
                    name="video"
                    id="video"
                    accept="video/*">

                </div>

              </div>

              <div id="selectedPagesContainer"></div>

              <button
                type="submit"
                class="publish-btn"
                id="publishButton">
                🚀 Publish to Selected Pages
              </button>

            </form>

          </div>
        `
        : ""
    }

  </div>

  <script>

    // =========================================================
    // PAGE CHECKBOX HELPERS
    // =========================================================

    function getPageCheckboxes() {
      return Array.from(
        document.querySelectorAll(".page-checkbox")
      );
    }

    function selectAllPages() {
      getPageCheckboxes().forEach(function (checkbox) {
        const row = checkbox.closest(".page-row");

        if (
          !row ||
          row.style.display !== "none"
        ) {
          checkbox.checked = true;
        }
      });
    }

    function unselectAllPages() {
      getPageCheckboxes().forEach(function (checkbox) {
        checkbox.checked = false;
      });
    }

    function selectAccount(accountId) {
      document
        .querySelectorAll(
          '.page-checkbox[data-account-id="' +
          CSS.escape(String(accountId)) +
          '"]'
        )
        .forEach(function (checkbox) {
          checkbox.checked = true;
        });
    }

    function unselectAccount(accountId) {
      document
        .querySelectorAll(
          '.page-checkbox[data-account-id="' +
          CSS.escape(String(accountId)) +
          '"]'
        )
        .forEach(function (checkbox) {
          checkbox.checked = false;
        });
    }

    // =========================================================
    // ACCOUNT BUTTONS
    // =========================================================

    document
      .querySelectorAll(".account-select-btn")
      .forEach(function (button) {

        button.addEventListener(
          "click",
          function () {

            const accountId =
              button.dataset.accountId;

            selectAccount(accountId);

          }
        );

      });

    document
      .querySelectorAll(".account-unselect-btn")
      .forEach(function (button) {

        button.addEventListener(
          "click",
          function () {

            const accountId =
              button.dataset.accountId;

            unselectAccount(accountId);

          }
        );

      });

    // =========================================================
    // SELECT ALL / UNSELECT ALL
    // =========================================================

    const selectAllButton =
      document.getElementById(
        "selectAllPagesButton"
      );

    if (selectAllButton) {
      selectAllButton.addEventListener(
        "click",
        selectAllPages
      );
    }

    const unselectAllButton =
      document.getElementById(
        "unselectAllPagesButton"
      );

    if (unselectAllButton) {
      unselectAllButton.addEventListener(
        "click",
        unselectAllPages
      );
    }

    // =========================================================
    // SEARCH
    // =========================================================

    const pageSearch =
      document.getElementById("pageSearch");

    if (pageSearch) {

      pageSearch.addEventListener(
        "input",
        function () {

          const search =
            pageSearch.value
              .trim()
              .toLowerCase();

          document
            .querySelectorAll(".page-row")
            .forEach(function (row) {

              const pageName =
                row.dataset.pageName || "";

              const pageId =
                row.dataset.pageId || "";

              const match =
                pageName
                  .toLowerCase()
                  .includes(search) ||
                pageId
                  .toLowerCase()
                  .includes(search);

              row.style.display =
                match ? "" : "none";

            });

        }
      );

    }

    // =========================================================
    // IMAGE / VIDEO
    // =========================================================

    const imageInput =
      document.getElementById("image");

    const videoInput =
      document.getElementById("video");

    if (imageInput) {

      imageInput.addEventListener(
        "change",
        function () {

          if (
            this.files.length > 0 &&
            videoInput
          ) {
            videoInput.value = "";
          }

        }
      );

    }

    if (videoInput) {

      videoInput.addEventListener(
        "change",
        function () {

          if (
            this.files.length > 0 &&
            imageInput
          ) {
            imageInput.value = "";
          }

        }
      );

    }

    // =========================================================
    // PUBLISH
    // =========================================================

    const publishForm =
      document.getElementById("publishForm");

    if (publishForm) {

      publishForm.addEventListener(
        "submit",
        function (event) {

          // ---------------------------------------------------
          // IMPORTANT:
          // Page checkboxes are outside publishForm.
          // Copy selected page IDs into hidden inputs.
          // ---------------------------------------------------

          const selectedPages =
            document.querySelectorAll(
              ".page-checkbox:checked"
            );

          const hiddenContainer =
            document.getElementById(
              "selectedPagesContainer"
            );

          if (hiddenContainer) {
            hiddenContainer.innerHTML = "";

            selectedPages.forEach(
              function (checkbox) {

                const hidden =
                  document.createElement("input");

                hidden.type = "hidden";
                hidden.name = "page_ids";
                hidden.value = checkbox.value;

                hiddenContainer.appendChild(hidden);

              }
            );
          }

          const message =
            document
              .getElementById("message")
              .value
              .trim();

          const hasImage =
            imageInput &&
            imageInput.files &&
            imageInput.files.length > 0;

          const hasVideo =
            videoInput &&
            videoInput.files &&
            videoInput.files.length > 0;

          if (
            selectedPages.length === 0
          ) {
            event.preventDefault();

            alert(
              "Please select at least one Facebook Page."
            );

            return;
          }

          if (
            !message &&
            !hasImage &&
            !hasVideo
          ) {
            event.preventDefault();

            alert(
              "Please enter a post message or select an image/video."
            );

            return;
          }

          if (
            hasImage &&
            hasVideo
          ) {
            event.preventDefault();

            alert(
              "Please select either an image OR a video, not both."
            );

            return;
          }

          const button =
            document.getElementById(
              "publishButton"
            );

          if (button) {
            button.disabled = true;
            button.textContent =
              "⏳ Publishing...";
          }

        }
      );

    }

    // =========================================================
    // SYNC / REMOVE BUTTONS
    // =========================================================

    document
      .querySelectorAll(".action-form")
      .forEach(function (form) {

        form.addEventListener(
          "submit",
          function (event) {

            const button =
              form.querySelector(
                'button[type="submit"]'
              );

            if (button) {

              if (
                form.action.includes(
                  "/remove-account"
                )
              ) {

                if (
                  !window.confirm(
                    "Are you sure you want to remove this Facebook account from the publisher?"
                  )
                ) {
                  event.preventDefault();
                  return;
                }

                button.disabled = true;
                button.textContent =
                  "⏳ Removing...";

              } else {

                button.disabled = true;
                button.textContent =
                  "⏳ Syncing...";

              }

            }

          }
        );

      });

    // =========================================================
    // REMOVE CONFIRM
    // =========================================================

    function confirmRemoveAccount() {
      // Confirmation is handled by the submit listener.
      // Return true here so the form can continue normally.
      return true;
    }

  </script>

</body>

</html>
  `;
}


// =============================================================
// PUBLISH RESULTS
// =============================================================

function publishResultsPage(
  results,
  message,
  hasImage,
  hasVideo
) {
  const successful =
    results.filter(
      (item) => item.success
    );

  const failed =
    results.filter(
      (item) => !item.success
    );

  return htmlResult(
    "Publish Results",
    `
      <h2>
        📣 Publish Results
      </h2>

      <div class="stats">

        <div class="stat">
          <strong>
            ${results.length}
          </strong>
          Total
        </div>

        <div class="stat">
          <strong>
            ${successful.length}
          </strong>
          Successful
        </div>

        <div class="stat">
          <strong>
            ${failed.length}
          </strong>
          Failed
        </div>

      </div>

      <br>

      ${
        successful.length
          ? `
            <div class="success-box">

              <h3>
                ✅ Successfully Published
              </h3>

              ${successful.map((item) => `
                <p>

                  <b>
                    ${escapeHtml(
                      item.pageName ||
                      "Unnamed Page"
                    )}
                  </b>

                  <br>

                  Page ID:
                  ${escapeHtml(
                    item.pageId || ""
                  )}

                  <br>

                  Post:
                  ${escapeHtml(
                    item.postId ||
                    "Published"
                  )}

                </p>
              `).join("")}

            </div>
          `
          : ""
      }

      ${
        failed.length
          ? `
            <div style="
              margin-top:20px;
              background:#fef2f2;
              border:1px solid #fecaca;
              padding:20px;
              border-radius:10px;
            ">

              <h3>
                ❌ Failed
              </h3>

              ${failed.map((item) => `
                <p>

                  <b>
                    ${escapeHtml(
                      item.pageName ||
                      "Unnamed Page"
                    )}
                  </b>

                  <br>

                  Page ID:
                  ${escapeHtml(
                    item.pageId || ""
                  )}

                  <br>

                  Error:
                  ${escapeHtml(
                    item.error ||
                    "Unknown error"
                  )}

                </p>
              `).join("")}

            </div>
          `
          : ""
      }

      <p style="margin-top:25px;">

        <a
          class="main-link"
          href="/">
          ← Back to Dashboard
        </a>

      </p>
    `
  );
}


// =============================================================
// HTML RESULT
// =============================================================

function htmlResult(
  title,
  content
) {
  return new Response(
    `
<!DOCTYPE html>

<html>

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0">

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
      background: #f4f7fb;
      font-family: Arial, Helvetica, sans-serif;
      color: #172033;
    }

    .box {
      max-width: 900px;
      margin: 30px auto;
      background: white;
      border-radius: 14px;
      padding: 30px;
      box-shadow: 0 4px 20px rgba(0,0,0,.07);
    }

    h1,
    h2,
    h3 {
      margin-top: 0;
    }

    .success-box {
      background: #ecfdf3;
      border: 1px solid #a7f3d0;
      padding: 20px;
      border-radius: 10px;
    }

    pre {
      background: #f3f4f6;
      padding: 15px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }

    .stats {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
    }

    .stat {
      background: #f4f7fb;
      border-radius: 10px;
      padding: 12px 18px;
      min-width: 140px;
    }

    .stat strong {
      display: block;
      font-size: 22px;
      margin-bottom: 4px;
    }

    .main-link {
      color: #1877f2;
      text-decoration: none;
      font-weight: bold;
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
      headers: {
        "content-type":
          "text/html; charset=UTF-8",
        "cache-control": "no-store"
      }
    }
  );
}


// =============================================================
// ESCAPE HTML
// =============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
