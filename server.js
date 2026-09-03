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
      // HOME / DASHBOARD
      // =========================================================
      if (request.method === "GET" && path === "/") {
        const accountsResult = await env.DB.prepare(`
          SELECT id, facebook_user_id, created_at
          FROM facebook_accounts
          ORDER BY id DESC
        `).all();

        const pagesResult = await env.DB.prepare(`
          SELECT
            p.id,
            p.account_id,
            p.page_id,
            p.page_name
          FROM facebook_pages p
          ORDER BY p.page_name COLLATE NOCASE ASC
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
                    <span class="account-id">ID: ${escapeHtml(account.facebook_user_id)}</span>
                  </h3>

                  <div class="account-pages-count">
                    ${accountPages.length} Page${accountPages.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="account-actions">
                  <button
                    type="button"
                    class="btn btn-blue"
                    onclick="selectAccount(${JSON.stringify(String(account.id))})"
                  >
                    ☑️ Select Account
                  </button>

                  <button
                    type="button"
                    class="btn btn-gray"
                    onclick="unselectAccount(${JSON.stringify(String(account.id))})"
                  >
                    ⬜ Unselect
                  </button>

                  <button
                    type="button"
                    class="btn btn-orange"
                    onclick="syncAccount(${JSON.stringify(String(account.id))}, this)"
                  >
                    🔄 Sync Pages
                  </button>

                  <button
                    type="button"
                    class="btn btn-red"
                    onclick="removeAccount(${JSON.stringify(String(account.id))}, this)"
                  >
                    🗑️ Remove Account
                  </button>
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
                          ${accountPages
                            .map(
                              (page) => `
                                <tr
                                  class="page-row"
                                  data-page-name="${escapeHtml(page.page_name || "")}"
                                  data-page-id="${escapeHtml(page.page_id || "")}"
                                >
                                  <td>
                                    <input
                                      type="checkbox"
                                      class="page-checkbox account-${escapeHtml(String(account.id))}"
                                      name="page_ids"
                                      value="${escapeHtml(page.page_id)}"
                                      data-account-id="${escapeHtml(String(account.id))}"
                                    >
                                  </td>

                                  <td class="page-name">
                                    ${escapeHtml(page.page_name || "")}
                                  </td>

                                  <td class="page-id">
                                    ${escapeHtml(page.page_id || "")}
                                  </td>
                                </tr>
                              `
                            )
                            .join("")}
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

        const totalPages = pages.length;
        const totalAccounts = accounts.length;

        return new Response(
          dashboardHtml({
            accountCards,
            totalAccounts,
            totalPages
          }),
          {
            headers: {
              "content-type": "text/html; charset=UTF-8"
            }
          }
        );
      }

      // =========================================================
      // META OAUTH START
      // =========================================================
      if (request.method === "GET" && path === "/auth/meta") {
        const redirectUri = `${url.origin}/auth/meta/callback`;

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
      // META OAUTH CALLBACK
      // =========================================================
      if (request.method === "GET" && path === "/auth/meta/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="result error">
                <h2>❌ Facebook Login Failed</h2>
                <p>${escapeHtml(errorDescription || error)}</p>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        if (!code) {
          return htmlResult(
            "Facebook Login Error",
            `
              <div class="result error">
                <h2>❌ No authorization code received.</h2>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const redirectUri = `${url.origin}/auth/meta/callback`;

        // ---------------------------------------------------------
        // Exchange code for user access token
        // ---------------------------------------------------------
        const tokenUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` +
          `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
          `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code=${encodeURIComponent(code)}`;

        const tokenResponse = await fetch(tokenUrl);
        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok || !tokenData.access_token) {
          return htmlResult(
            "Facebook Token Error",
            `
              <div class="result error">
                <h2>❌ Failed to get Facebook Access Token</h2>
                <pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const userAccessToken = tokenData.access_token;

        // ---------------------------------------------------------
        // Get Facebook user ID
        // ---------------------------------------------------------
        const meUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me` +
          `?fields=id` +
          `&access_token=${encodeURIComponent(userAccessToken)}`;

        const meResponse = await fetch(meUrl);
        const meData = await meResponse.json();

        if (!meResponse.ok || !meData.id) {
          return htmlResult(
            "Facebook User Error",
            `
              <div class="result error">
                <h2>❌ Could not get Facebook User ID</h2>
                <pre>${escapeHtml(JSON.stringify(meData, null, 2))}</pre>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const facebookUserId = String(meData.id);

        // ---------------------------------------------------------
        // Save / update Facebook account
        // ---------------------------------------------------------
        await env.DB.prepare(`
          INSERT INTO facebook_accounts
            (facebook_user_id, access_token)
          VALUES (?, ?)
          ON CONFLICT(facebook_user_id)
          DO UPDATE SET
            access_token = excluded.access_token
        `)
          .bind(facebookUserId, userAccessToken)
          .run();

        const accountResult = await env.DB.prepare(`
          SELECT id
          FROM facebook_accounts
          WHERE facebook_user_id = ?
          LIMIT 1
        `)
          .bind(facebookUserId)
          .first();

        if (!accountResult) {
          return htmlResult(
            "Database Error",
            `
              <div class="result error">
                <h2>❌ Facebook account could not be saved.</h2>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const accountId = accountResult.id;

        // ---------------------------------------------------------
        // Get Pages
        // ---------------------------------------------------------
        let accountsUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
          `?fields=id,name,access_token` +
          `&limit=100` +
          `&access_token=${encodeURIComponent(userAccessToken)}`;

        let pageCount = 0;

        while (accountsUrl) {
          const pagesResponse = await fetch(accountsUrl);
          const pagesData = await pagesResponse.json();

          if (!pagesResponse.ok || pagesData.error) {
            return htmlResult(
              "Pages Error",
              `
                <div class="result error">
                  <h2>❌ Could not load Facebook Pages</h2>
                  <pre>${escapeHtml(JSON.stringify(pagesData, null, 2))}</pre>
                </div>
                <a class="back-link" href="/">← Back to Publisher</a>
              `
            );
          }

          for (const page of pagesData.data || []) {
            if (!page.id || !page.access_token) continue;

            await env.DB.prepare(`
              INSERT INTO facebook_pages
                (account_id, page_id, page_name, page_access_token)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(account_id, page_id)
              DO UPDATE SET
                page_name = excluded.page_name,
                page_access_token = excluded.page_access_token
            `)
              .bind(
                accountId,
                String(page.id),
                page.name || "",
                page.access_token
              )
              .run();

            pageCount++;
          }

          accountsUrl = pagesData.paging?.next || null;
        }

        return htmlResult(
          "Facebook Connected",
          `
            <div class="result success">
              <h2>✅ Facebook Account Connected</h2>
              <p>
                Facebook User ID:
                <b>${escapeHtml(facebookUserId)}</b>
              </p>
              <p>
                Pages saved/updated:
                <b>${pageCount}</b>
              </p>
            </div>

            <a class="back-link" href="/">← Back to Publisher</a>
          `
        );
      }

      // =========================================================
      // SYNC PAGES
      // =========================================================
      if (request.method === "POST" && path === "/sync-pages") {
        const formData = await request.formData();
        const accountId = formData.get("account_id");

        if (!accountId) {
          return htmlResult(
            "Sync Error",
            `
              <div class="result error">
                <h2>❌ Account ID missing.</h2>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const account = await env.DB.prepare(`
          SELECT id, facebook_user_id, access_token
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
              <div class="result error">
                <h2>❌ Facebook account not found.</h2>
              </div>
              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        let accountsUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
          `?fields=id,name,access_token` +
          `&limit=100` +
          `&access_token=${encodeURIComponent(account.access_token)}`;

        let found = 0;
        let saved = 0;
        let newPages = 0;
        let updatedPages = 0;

        try {
          while (accountsUrl) {
            const response = await fetch(accountsUrl);
            const data = await response.json();

            if (!response.ok || data.error) {
              return htmlResult(
                "Sync Error",
                `
                  <div class="result error">
                    <h2>❌ Facebook Pages Sync Failed</h2>

                    <p>
                      Facebook may have expired/revoked this account's
                      access token.
                    </p>

                    <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>

                    <p>
                      Please reconnect this Facebook account.
                    </p>
                  </div>

                  <a class="back-link" href="/">← Back to Publisher</a>
                `
              );
            }

            for (const page of data.data || []) {
              if (!page.id || !page.access_token) continue;

              found++;

              const existing = await env.DB.prepare(`
                SELECT id
                FROM facebook_pages
                WHERE account_id = ?
                  AND page_id = ?
                LIMIT 1
              `)
                .bind(account.id, String(page.id))
                .first();

              await env.DB.prepare(`
                INSERT INTO facebook_pages
                  (account_id, page_id, page_name, page_access_token)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(account_id, page_id)
                DO UPDATE SET
                  page_name = excluded.page_name,
                  page_access_token = excluded.page_access_token
              `)
                .bind(
                  account.id,
                  String(page.id),
                  page.name || "",
                  page.access_token
                )
                .run();

              if (existing) {
                updatedPages++;
              } else {
                newPages++;
              }

              saved++;
            }

            accountsUrl = data.paging?.next || null;
          }
        } catch (error) {
          return htmlResult(
            "Sync Error",
            `
              <div class="result error">
                <h2>❌ Sync failed</h2>
                <pre>${escapeHtml(String(error))}</pre>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        return htmlResult(
          "Pages Synced",
          `
            <div class="result success">
              <h2>✅ Pages Synced Successfully</h2>

              <p>
                Facebook Account:
                <b>${escapeHtml(account.facebook_user_id)}</b>
              </p>

              <p>
                Pages found:
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

            <a class="back-link" href="/">← Back to Publisher</a>
          `
        );
      }

      // =========================================================
      // REMOVE ACCOUNT
      // =========================================================
      if (request.method === "POST" && path === "/remove-account") {
        const formData = await request.formData();
        const accountId = formData.get("account_id");

        if (!accountId) {
          return htmlResult(
            "Remove Error",
            `
              <div class="result error">
                <h2>❌ Account ID missing.</h2>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const account = await env.DB.prepare(`
          SELECT id, facebook_user_id
          FROM facebook_accounts
          WHERE id = ?
          LIMIT 1
        `)
          .bind(accountId)
          .first();

        if (!account) {
          return htmlResult(
            "Remove Error",
            `
              <div class="result error">
                <h2>❌ Facebook account not found.</h2>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        // Delete Pages first
        await env.DB.prepare(`
          DELETE FROM facebook_pages
          WHERE account_id = ?
        `)
          .bind(account.id)
          .run();

        // Then delete account
        await env.DB.prepare(`
          DELETE FROM facebook_accounts
          WHERE id = ?
        `)
          .bind(account.id)
          .run();

        return htmlResult(
          "Account Removed",
          `
            <div class="result success">
              <h2>✅ Account Removed</h2>

              <p>
                Facebook User ID:
                <b>${escapeHtml(account.facebook_user_id)}</b>
              </p>

              <p>
                The account and its saved Pages were removed from this
                Publisher database.
              </p>

              <p>
                Your actual Facebook account/Page has <b>not</b> been deleted.
              </p>
            </div>

            <a class="back-link" href="/">← Back to Publisher</a>
          `
        );
      }

      // =========================================================
      // PUBLISH
      // =========================================================
      if (request.method === "POST" && path === "/publish") {
        const formData = await request.formData();

        const message = String(formData.get("message") || "").trim();

        const pageIds = formData
          .getAll("page_ids")
          .map((id) => String(id))
          .filter(Boolean);

        const image = formData.get("image");
        const video = formData.get("video");

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

        if (!pageIds.length) {
          return htmlResult(
            "Publish Error",
            `
              <div class="result error">
                <h2>❌ No Pages Selected</h2>
                <p>Please select at least one Facebook Page.</p>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        if (!message && !hasImage && !hasVideo) {
          return htmlResult(
            "Publish Error",
            `
              <div class="result error">
                <h2>❌ Nothing to Publish</h2>
                <p>
                  Enter some text or upload an image/video.
                </p>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        if (hasImage && hasVideo) {
          return htmlResult(
            "Publish Error",
            `
              <div class="result error">
                <h2>❌ Image and Video Cannot Be Used Together</h2>
                <p>Please choose either an image or a video.</p>
              </div>

              <a class="back-link" href="/">← Back to Publisher</a>
            `
          );
        }

        const placeholders = pageIds.map(() => "?").join(",");

        const pagesResult = await env.DB.prepare(`
          SELECT
            id,
            account_id,
            page_id,
            page_name,
            page_access_token
          FROM facebook_pages
          WHERE page_id IN (${placeholders})
        `)
          .bind(...pageIds)
          .all();

        const pagesToPublish = pagesResult.results || [];

        const results = [];

        for (const page of pagesToPublish) {
          try {
            let endpoint = "";
            let body;

            // ---------------------------------------------------
            // VIDEO
            // ---------------------------------------------------
            if (hasVideo) {
              endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}` +
                `/${encodeURIComponent(page.page_id)}/videos`;

              const videoBytes = await video.arrayBuffer();

              const videoForm = new FormData();

              videoForm.append(
                "source",
                new Blob([videoBytes], {
                  type: video.type || "video/mp4"
                }),
                video.name || "video.mp4"
              );

              if (message) {
                videoForm.append("description", message);
              }

              videoForm.append("access_token", page.page_access_token);

              body = videoForm;
            }

            // ---------------------------------------------------
            // IMAGE
            // ---------------------------------------------------
            else if (hasImage) {
              endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}` +
                `/${encodeURIComponent(page.page_id)}/photos`;

              const imageBytes = await image.arrayBuffer();

              const imageForm = new FormData();

              imageForm.append(
                "source",
                new Blob([imageBytes], {
                  type: image.type || "image/jpeg"
                }),
                image.name || "image.jpg"
              );

              if (message) {
                imageForm.append("caption", message);
              }

              imageForm.append("access_token", page.page_access_token);

              body = imageForm;
            }

            // ---------------------------------------------------
            // TEXT
            // ---------------------------------------------------
            else {
              endpoint =
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}` +
                `/${encodeURIComponent(page.page_id)}/feed`;

              const publishForm = new URLSearchParams();

              publishForm.set(
                "message",
                message
              );

              publishForm.set(
                "access_token",
                page.page_access_token
              );

              body = publishForm;
            }

            const response = await fetch(endpoint, {
              method: "POST",
              body
            });

            const data = await response.json();

            if (response.ok && !data.error) {
              results.push({
                success: true,
                page_name: page.page_name,
                page_id: page.page_id,
                data
              });
            } else {
              results.push({
                success: false,
                page_name: page.page_name,
                page_id: page.page_id,
                error: data
              });
            }
          } catch (error) {
            results.push({
              success: false,
              page_name: page.page_name,
              page_id: page.page_id,
              error: {
                message: String(error)
              }
            });
          }
        }

        // Selected Page IDs which were not found in DB
        const foundIds = new Set(
          pagesToPublish.map((page) => String(page.page_id))
        );

        for (const requestedPageId of pageIds) {
          if (!foundIds.has(String(requestedPageId))) {
            results.push({
              success: false,
              page_name: "Unknown Page",
              page_id: requestedPageId,
              error: {
                message: "Page not found in Publisher database."
              }
            });
          }
        }

        return publishResultsPage(results);
      }

      // =========================================================
      // 404
      // =========================================================
      return new Response("Not Found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=UTF-8"
        }
      });
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
                padding: 30px;
                background: #f5f5f5;
              }
              .box {
                background: white;
                padding: 25px;
                border-radius: 12px;
                max-width: 900px;
                margin: auto;
                box-shadow: 0 2px 12px rgba(0,0,0,.08);
              }
              pre {
                white-space: pre-wrap;
                word-break: break-word;
                background: #111;
                color: #fff;
                padding: 15px;
                border-radius: 8px;
              }
            </style>
          </head>
          <body>
            <div class="box">
              <h2>❌ Worker Error</h2>
              <pre>${escapeHtml(String(error?.stack || error))}</pre>
              <a href="/">← Back</a>
            </div>
          </body>
          </html>
        `,
        {
          status: 500,
          headers: {
            "content-type": "text/html; charset=UTF-8"
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
<!doctype html>
<html>
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
      padding: 0;
      background: #f4f6f8;
      color: #1f2937;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
    }

    .container {
      width: min(1200px, calc(100% - 30px));
      margin: 30px auto;
    }

    .topbar {
      background: white;
      border-radius: 14px;
      padding: 22px;
      margin-bottom: 20px;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
    }

    .topbar h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }

    .topbar p {
      margin: 0;
      color: #6b7280;
    }

    .stats {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      margin-top: 18px;
    }

    .stat {
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px 18px;
      min-width: 150px;
    }

    .stat-number {
      font-size: 24px;
      font-weight: 700;
    }

    .stat-label {
      color: #6b7280;
      font-size: 13px;
      margin-top: 3px;
    }

    .connect-box {
      background: white;
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
    }

    .connect-box h2 {
      margin-top: 0;
    }

    .btn {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: .15s;
    }

    .btn:hover {
      transform: translateY(-1px);
      opacity: .92;
    }

    .btn:disabled {
      opacity: .6;
      cursor: not-allowed;
      transform: none;
    }

    .btn-green {
      background: #16a34a;
      color: white;
    }

    .btn-blue {
      background: #2563eb;
      color: white;
    }

    .btn-gray {
      background: #6b7280;
      color: white;
    }

    .btn-orange {
      background: #ea580c;
      color: white;
    }

    .btn-red {
      background: #dc2626;
      color: white;
    }

    .btn-dark {
      background: #111827;
      color: white;
    }

    .account-card {
      background: white;
      border-radius: 14px;
      margin-bottom: 20px;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
      overflow: hidden;
    }

    .account-header {
      padding: 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      flex-wrap: wrap;
      border-bottom: 1px solid #e5e7eb;
    }

    .account-header h3 {
      margin: 0 0 5px;
      font-size: 18px;
    }

    .account-id {
      color: #6b7280;
      font-size: 12px;
      font-weight: normal;
      margin-left: 8px;
    }

    .account-pages-count {
      color: #6b7280;
      font-size: 13px;
    }

    .account-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
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
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #edf0f2;
    }

    .page-table th {
      background: #f8fafc;
      font-size: 13px;
      color: #4b5563;
    }

    .page-table td {
      font-size: 14px;
    }

    .page-table tr:last-child td {
      border-bottom: 0;
    }

    .page-checkbox {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }

    .page-id {
      color: #6b7280;
      font-family: monospace;
      font-size: 13px;
    }

    .no-pages {
      padding: 18px;
      color: #6b7280;
      background: #fafafa;
    }

    .publisher-box {
      background: white;
      border-radius: 14px;
      padding: 22px;
      margin-top: 25px;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
    }

    .publisher-box h2 {
      margin-top: 0;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 15px;
    }

    .search {
      width: 100%;
      max-width: 500px;
      padding: 12px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 15px;
    }

    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: 13px;
      border: 1px solid #d1d5db;
      border-radius: 9px;
      font-family: Arial, sans-serif;
      font-size: 15px;
      margin-bottom: 15px;
    }

    .upload-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 18px;
    }

    .upload-box {
      border: 1px solid #d1d5db;
      border-radius: 9px;
      padding: 14px;
      background: #fafafa;
    }

    .upload-box label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
    }

    input[type="file"] {
      width: 100%;
    }

    .publish-button {
      width: 100%;
      padding: 14px;
      font-size: 16px;
    }

    .empty {
      background: white;
      border-radius: 14px;
      padding: 30px;
      text-align: center;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
      margin-bottom: 20px;
    }

    @media (max-width: 700px) {
      .upload-row {
        grid-template-columns: 1fr;
      }

      .account-actions {
        width: 100%;
      }

      .account-actions .btn {
        flex: 1;
        min-width: 130px;
      }
    }
  </style>
</head>

<body>

<div class="container">

  <div class="topbar">
    <h1>📣 Meta Multi Page Publisher</h1>

    <p>
      Publish text, images or videos to multiple Facebook Pages.
    </p>

    <div class="stats">
      <div class="stat">
        <div class="stat-number">${totalAccounts}</div>
        <div class="stat-label">Connected Facebook Accounts</div>
      </div>

      <div class="stat">
        <div class="stat-number">${totalPages}</div>
        <div class="stat-label">Connected Pages</div>
      </div>
    </div>
  </div>


  <div class="connect-box">
    <h2>🔗 Facebook Accounts</h2>

    <p>
      Connect another Facebook account to import its Pages.
    </p>

    <a href="/auth/meta">
      <button
        type="button"
        class="btn btn-green"
      >
        ➕ Connect Facebook Account
      </button>
    </a>
  </div>


  ${
    totalAccounts
      ? accountCards
      : `
        <div class="empty">
          <h2>👋 No Facebook Accounts Connected</h2>
          <p>
            Click "Connect Facebook Account" above to get started.
          </p>
        </div>
      `
  }


  ${
    totalPages
      ? `
        <!-- IMPORTANT:
             There is ONLY ONE publish form here.
             Account Sync / Remove buttons above are NOT forms.
        -->

        <form
          method="POST"
          action="/publish"
          enctype="multipart/form-data"
          id="publishForm"
        >

          <div class="publisher-box">

            <h2>📝 Create Post</h2>

            <div class="toolbar">
              <button
                type="button"
                class="btn btn-dark"
                onclick="selectAllPages()"
              >
                ☑️ Select All Pages
              </button>

              <button
                type="button"
                class="btn btn-gray"
                onclick="unselectAllPages()"
              >
                ⬜ Unselect All
              </button>
            </div>

            <input
              type="text"
              id="pageSearch"
              class="search"
              placeholder="🔍 Search Page Name or Page ID..."
              oninput="searchPages()"
            >

            <textarea
              name="message"
              id="message"
              placeholder="Write your post here..."
            ></textarea>


            <div class="upload-row">

              <div class="upload-box">
                <label>🖼️ Image</label>

                <input
                  type="file"
                  name="image"
                  id="imageInput"
                  accept="image/*"
                  onchange="imageSelected()"
                >
              </div>


              <div class="upload-box">
                <label>🎥 Video</label>

                <input
                  type="file"
                  name="video"
                  id="videoInput"
                  accept="video/*"
                  onchange="videoSelected()"
                >
              </div>

            </div>


            <button
              type="submit"
              class="btn btn-blue publish-button"
              id="publishButton"
            >
              🚀 Publish to Selected Pages
            </button>

          </div>

        </form>
      `
      : ""
  }

</div>


<script>

  // ===========================================================
  // SELECT ACCOUNT
  // ===========================================================
  function selectAccount(accountId) {
    const boxes = document.querySelectorAll(
      '.account-' + CSS.escape(accountId)
    );

    boxes.forEach(function(box) {
      box.checked = true;
    });

    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth"
    });
  }


  // ===========================================================
  // UNSELECT ACCOUNT
  // ===========================================================
  function unselectAccount(accountId) {
    const boxes = document.querySelectorAll(
      '.account-' + CSS.escape(accountId)
    );

    boxes.forEach(function(box) {
      box.checked = false;
    });
  }


  // ===========================================================
  // SELECT ALL PAGES
  // ===========================================================
  function selectAllPages() {
    document
      .querySelectorAll(".page-checkbox")
      .forEach(function(box) {
        box.checked = true;
      });
  }


  // ===========================================================
  // UNSELECT ALL PAGES
  // ===========================================================
  function unselectAllPages() {
    document
      .querySelectorAll(".page-checkbox")
      .forEach(function(box) {
        box.checked = false;
      });
  }


  // ===========================================================
  // SEARCH PAGES
  // ===========================================================
  function searchPages() {
    const search = document
      .getElementById("pageSearch")
      .value
      .toLowerCase()
      .trim();

    document
      .querySelectorAll(".page-row")
      .forEach(function(row) {

        const pageName =
          (row.dataset.pageName || "").toLowerCase();

        const pageId =
          (row.dataset.pageId || "").toLowerCase();

        if (
          !search ||
          pageName.includes(search) ||
          pageId.includes(search)
        ) {
          row.style.display = "";
        } else {
          row.style.display = "none";
        }
      });
  }


  // ===========================================================
  // IMAGE / VIDEO MUTUALLY EXCLUSIVE
  // ===========================================================
  function imageSelected() {
    const image =
      document.getElementById("imageInput");

    const video =
      document.getElementById("videoInput");

    if (image.files.length > 0) {
      video.value = "";
    }
  }


  function videoSelected() {
    const image =
      document.getElementById("imageInput");

    const video =
      document.getElementById("videoInput");

    if (video.files.length > 0) {
      image.value = "";
    }
  }


  // ===========================================================
  // SYNC ACCOUNT
  // IMPORTANT:
  // NO FORM SUBMISSION HERE.
  // ===========================================================
  async function syncAccount(accountId, button) {

    if (button.dataset.busy === "1") {
      return;
    }

    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = "⏳ Syncing...";

    try {

      const body = new URLSearchParams();

      body.set("account_id", accountId);

      const response = await fetch("/sync-pages", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });

      const html = await response.text();

      document.open();
      document.write(html);
      document.close();

    } catch (error) {

      alert(
        "Sync failed: " + String(error)
      );

      button.dataset.busy = "0";
      button.disabled = false;
      button.textContent = "🔄 Sync Pages";
    }
  }


  // ===========================================================
  // REMOVE ACCOUNT
  // IMPORTANT:
  // NO FORM SUBMISSION HERE.
  // THIS CANNOT TRIGGER /publish.
  // ===========================================================
  async function removeAccount(accountId, button) {

    const confirmed = confirm(
      "Are you sure you want to remove this Facebook account?\\n\\n" +
      "Its saved Pages will also be removed from this Publisher.\\n\\n" +
      "Your actual Facebook account/Page will NOT be deleted."
    );

    if (!confirmed) {
      return;
    }

    if (button.dataset.busy === "1") {
      return;
    }

    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = "⏳ Removing...";

    try {

      const body = new URLSearchParams();

      body.set("account_id", accountId);

      const response = await fetch("/remove-account", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });

      const html = await response.text();

      document.open();
      document.write(html);
      document.close();

    } catch (error) {

      alert(
        "Remove Account failed: " + String(error)
      );

      button.dataset.busy = "0";
      button.disabled = false;
      button.textContent = "🗑️ Remove Account";
    }
  }


  // ===========================================================
  // PUBLISH FORM PROTECTION
  // ===========================================================
  const publishForm =
    document.getElementById("publishForm");

  if (publishForm) {

    publishForm.addEventListener(
      "submit",
      function(event) {

        const selected =
          document.querySelectorAll(
            '.page-checkbox:checked'
          );

        if (!selected.length) {

          event.preventDefault();

          alert(
            "Please select at least one Facebook Page."
          );

          return;
        }

        const message =
          document
            .getElementById("message")
            .value
            .trim();

        const image =
          document
            .getElementById("imageInput");

        const video =
          document
            .getElementById("videoInput");

        const hasImage =
          image.files &&
          image.files.length > 0;

        const hasVideo =
          video.files &&
          video.files.length > 0;

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

        if (hasImage && hasVideo) {

          event.preventDefault();

          alert(
            "Please select either an image OR a video, not both."
          );

          return;
        }

        const button =
          document.getElementById("publishButton");

        if (button) {
          button.disabled = true;
          button.textContent = "⏳ Publishing...";
        }
      }
    );
  }

</script>

</body>
</html>
  `;
}


// =============================================================
// PUBLISH RESULTS PAGE
// =============================================================
function publishResultsPage(results) {
  const successful = results.filter(
    (result) => result.success
  );

  const failed = results.filter(
    (result) => !result.success
  );

  return htmlResult(
    "Publish Results",
    `
      <div class="result success">
        <h2>🚀 Publish Process Completed</h2>

        <p>
          Successful:
          <b>${successful.length}</b>
        </p>

        <p>
          Failed:
          <b>${failed.length}</b>
        </p>
      </div>


      ${
        successful.length
          ? `
            <div class="results-box">
              <h3>✅ Successful Pages</h3>

              ${successful
                .map(
                  (result) => `
                    <div class="result-row success-row">
                      <b>${escapeHtml(result.page_name || "Unknown Page")}</b>

                      <span>
                        Page ID:
                        ${escapeHtml(result.page_id)}
                      </span>

                      <small>
                        Published successfully.
                      </small>
                    </div>
                  `
                )
                .join("")}
            </div>
          `
          : ""
      }


      ${
        failed.length
          ? `
            <div class="results-box">
              <h3>❌ Failed Pages</h3>

              ${failed
                .map(
                  (result) => `
                    <div class="result-row failed-row">

                      <b>
                        ${escapeHtml(result.page_name || "Unknown Page")}
                      </b>

                      <span>
                        Page ID:
                        ${escapeHtml(result.page_id)}
                      </span>

                      <pre>${escapeHtml(
                        JSON.stringify(
                          result.error,
                          null,
                          2
                        )
                      )}</pre>

                    </div>
                  `
                )
                .join("")}
            </div>
          `
          : ""
      }


      <a
        class="back-link"
        href="/"
      >
        ← Back to Publisher
      </a>


      <style>
        .result {
          padding: 20px;
          border-radius: 12px;
          margin-bottom: 20px;
        }

        .result.success {
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
        }

        .result.error {
          background: #fef2f2;
          border: 1px solid #fecaca;
        }

        .results-box {
          background: white;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          box-shadow: 0 3px 14px rgba(0,0,0,.07);
        }

        .result-row {
          padding: 13px 0;
          border-bottom: 1px solid #e5e7eb;
        }

        .result-row:last-child {
          border-bottom: 0;
        }

        .result-row span {
          display: block;
          color: #6b7280;
          font-size: 13px;
          margin-top: 4px;
        }

        .result-row small {
          display: block;
          margin-top: 5px;
        }

        .failed-row {
          background: #fff7f7;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 8px;
        }

        pre {
          white-space: pre-wrap;
          word-break: break-word;
          background: #111827;
          color: white;
          padding: 12px;
          border-radius: 7px;
          overflow-x: auto;
        }

        .back-link {
          display: inline-block;
          margin-top: 10px;
          padding: 11px 15px;
          background: #2563eb;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
        }
      </style>
    `
  );
}


// =============================================================
// GENERIC RESULT PAGE
// =============================================================
function htmlResult(title, content) {
  return new Response(
    `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>${escapeHtml(title)}</title>

  <style>
    body {
      margin: 0;
      padding: 30px;
      background: #f4f6f8;
      font-family: Arial, Helvetica, sans-serif;
      color: #1f2937;
    }

    .container {
      max-width: 950px;
      margin: auto;
    }

    .box {
      background: white;
      border-radius: 14px;
      padding: 25px;
      box-shadow: 0 3px 14px rgba(0,0,0,.07);
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #111827;
      color: white;
      padding: 15px;
      border-radius: 8px;
      overflow-x: auto;
    }

    .back-link {
      display: inline-block;
      margin-top: 15px;
      padding: 11px 15px;
      background: #2563eb;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
    }
  </style>
</head>

<body>

  <div class="container">
    <div class="box">
      ${content}
    </div>
  </div>

</body>
</html>
    `,
    {
      headers: {
        "content-type": "text/html; charset=UTF-8"
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
