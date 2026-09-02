export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // HOME / DASHBOARD
    // =========================
    if (url.pathname === "/") {
      const pages = await env.DB.prepare(`
        SELECT
          facebook_pages.id,
          facebook_pages.page_id,
          facebook_pages.page_name,
          facebook_accounts.facebook_user_id
        FROM facebook_pages
        JOIN facebook_accounts
          ON facebook_pages.account_id = facebook_accounts.id
        ORDER BY facebook_pages.id DESC
      `).all();

      const pageRows = (pages.results || [])
        .map(
          (page) => `
            <tr>
              <td>
                <input
                  type="checkbox"
                  name="page_ids"
                  value="${escapeHtml(page.page_id)}"
                >
              </td>
              <td>${escapeHtml(page.page_name)}</td>
              <td>${escapeHtml(page.page_id)}</td>
              <td>${escapeHtml(page.facebook_user_id)}</td>
            </tr>
          `
        )
        .join("");

      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Meta Multi Page Publisher</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">

          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 30px;
              background: #f5f7fb;
              margin: 0;
            }

            .box {
              background: white;
              padding: 25px;
              border-radius: 12px;
              max-width: 1100px;
              margin: auto;
              box-shadow: 0 2px 10px rgba(0,0,0,.05);
            }

            h2 {
              margin-top: 0;
            }

            .button {
              display: inline-block;
              background: #1877f2;
              color: white;
              padding: 12px 18px;
              border-radius: 8px;
              text-decoration: none;
              border: none;
              cursor: pointer;
              font-size: 15px;
            }

            .publish-button {
              background: #16a34a;
              margin-top: 15px;
            }

            textarea {
              width: 100%;
              min-height: 130px;
              padding: 12px;
              box-sizing: border-box;
              border: 1px solid #ccc;
              border-radius: 8px;
              font-family: Arial;
              font-size: 15px;
              resize: vertical;
            }

            input[type="file"] {
              margin-top: 10px;
              margin-bottom: 15px;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 20px;
            }

            th, td {
              padding: 10px;
              border-bottom: 1px solid #ddd;
              text-align: left;
            }

            th {
              background: #f0f2f5;
            }

            .post-box {
              margin-top: 25px;
              padding: 20px;
              background: #f8fafc;
              border-radius: 10px;
            }

            .results {
              margin-top: 25px;
              padding: 15px;
              background: #f0fdf4;
              border-radius: 10px;
            }

            .error {
              background: #fef2f2;
            }

            .select-row {
              margin-top: 10px;
              margin-bottom: 10px;
            }
          </style>
        </head>

        <body>
          <div class="box">

            <h2>Meta Multi Page Publisher</h2>

            <p>
              Connected Pages:
              <strong>${pages.results?.length || 0}</strong>
            </p>

            <a class="button" href="/auth/meta">
              + Connect Facebook Account
            </a>

            ${
              pages.results?.length
                ? `
                  <form
                    method="POST"
                    action="/publish"
                    enctype="multipart/form-data"
                  >

                    <div class="post-box">

                      <h3>Create Post</h3>

                      <label>
                        <strong>Post Text</strong>
                      </label>

                      <br><br>

                      <textarea
                        name="message"
                        placeholder="Write your Facebook post here..."
                      ></textarea>

                      <br><br>

                      <label>
                        <strong>Image (optional)</strong>
                      </label>

                      <br>

                      <input
                        type="file"
                        name="image"
                        accept="image/*"
                      >

                      <h3>Select Pages</h3>

                      <div class="select-row">
                        <button
                          type="button"
                          onclick="selectAllPages()"
                        >
                          Select All
                        </button>

                        <button
                          type="button"
                          onclick="unselectAllPages()"
                        >
                          Unselect All
                        </button>
                      </div>

                      <table>
                        <thead>
                          <tr>
                            <th>Select</th>
                            <th>Page Name</th>
                            <th>Page ID</th>
                            <th>Facebook Account</th>
                          </tr>
                        </thead>

                        <tbody>
                          ${pageRows}
                        </tbody>
                      </table>

                      <button
                        class="button publish-button"
                        type="submit"
                      >
                        🚀 Publish to Selected Pages
                      </button>

                    </div>

                  </form>

                  <script>
                    function selectAllPages() {
                      document
                        .querySelectorAll('input[name="page_ids"]')
                        .forEach(cb => cb.checked = true);
                    }

                    function unselectAllPages() {
                      document
                        .querySelectorAll('input[name="page_ids"]')
                        .forEach(cb => cb.checked = false);
                    }
                  </script>
                `
                : "<p>No Facebook Pages connected yet.</p>"
            }

          </div>
        </body>
        </html>
      `, {
        headers: {
          "content-type": "text/html;charset=UTF-8"
        }
      });
    }

    // =========================
    // START FACEBOOK LOGIN
    // =========================
    if (url.pathname === "/auth/meta") {
      const redirectUri =
        `${url.origin}/auth/meta/callback`;

      const facebookUrl =
        `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth` +
        `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(
          "pages_show_list,pages_read_engagement,pages_manage_posts"
        )}`;

      return Response.redirect(facebookUrl, 302);
    }

    // =========================
    // FACEBOOK CALLBACK
    // =========================
    if (url.pathname === "/auth/meta/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription =
        url.searchParams.get("error_description");

      if (error) {
        return new Response(
          `Facebook login failed: ${escapeHtml(
            errorDescription || error
          )}`,
          { status: 400 }
        );
      }

      if (!code) {
        return new Response(
          "Missing Facebook authorization code.",
          { status: 400 }
        );
      }

      const redirectUri =
        `${url.origin}/auth/meta/callback`;

      // =========================
      // EXCHANGE CODE FOR TOKEN
      // =========================
      const tokenUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code=${encodeURIComponent(code)}`;

      const tokenResponse = await fetch(tokenUrl);
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || tokenData.error) {
        return new Response(
          `<pre>${escapeHtml(
            JSON.stringify(tokenData, null, 2)
          )}</pre>`,
          {
            status: 400,
            headers: {
              "content-type": "text/html;charset=UTF-8"
            }
          }
        );
      }

      const userAccessToken = tokenData.access_token;

      // =========================
      // GET FACEBOOK USER ID
      // =========================
      const meUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me` +
        `?fields=id` +
        `&access_token=${encodeURIComponent(
          userAccessToken
        )}`;

      const meResponse = await fetch(meUrl);
      const meData = await meResponse.json();

      if (!meResponse.ok || meData.error || !meData.id) {
        return new Response(
          `<pre>${escapeHtml(
            JSON.stringify(meData, null, 2)
          )}</pre>`,
          {
            status: 400,
            headers: {
              "content-type": "text/html;charset=UTF-8"
            }
          }
        );
      }

      const facebookUserId = meData.id;

      // =========================
      // SAVE / UPDATE ACCOUNT
      // =========================
      await env.DB.prepare(`
        INSERT INTO facebook_accounts
          (facebook_user_id, access_token)
        VALUES (?, ?)
        ON CONFLICT(facebook_user_id)
        DO UPDATE SET
          access_token = excluded.access_token
      `)
        .bind(
          facebookUserId,
          userAccessToken
        )
        .run();

      const accountResult = await env.DB.prepare(`
        SELECT id
        FROM facebook_accounts
        WHERE facebook_user_id = ?
      `)
        .bind(facebookUserId)
        .first();

      const accountId = accountResult.id;

      // =========================
      // GET FACEBOOK PAGES
      // =========================
      const pagesUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
        `?fields=id,name,access_token` +
        `&access_token=${encodeURIComponent(
          userAccessToken
        )}`;

      const pagesResponse = await fetch(pagesUrl);
      const pagesData = await pagesResponse.json();

      if (!pagesResponse.ok || pagesData.error) {
        return new Response(
          `<pre>${escapeHtml(
            JSON.stringify(pagesData, null, 2)
          )}</pre>`,
          {
            status: 400,
            headers: {
              "content-type": "text/html;charset=UTF-8"
            }
          }
        );
      }

      // =========================
      // SAVE PAGES
      // =========================
      for (const page of pagesData.data || []) {
        if (!page.id || !page.name || !page.access_token) {
          continue;
        }

        // Check if page already exists for this account
        const existingPage = await env.DB.prepare(`
          SELECT id
          FROM facebook_pages
          WHERE account_id = ?
            AND page_id = ?
        `)
          .bind(accountId, page.id)
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
              page.name,
              page.access_token,
              existingPage.id
            )
            .run();
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
              page.id,
              page.name,
              page.access_token
            )
            .run();
        }
      }

      // =========================
      // SUCCESS PAGE
      // =========================
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Facebook Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>

        <body style="font-family:Arial;padding:30px">

          <h2>Facebook Connected ✅</h2>

          <p>
            Facebook Account Connected:
            <strong>${escapeHtml(facebookUserId)}</strong>
          </p>

          <p>
            Pages found:
            <strong>${pagesData.data?.length || 0}</strong>
          </p>

          <p>
            Pages have been saved to the database.
          </p>

          <p>
            <a href="/">← Back to Dashboard</a>
          </p>

        </body>
        </html>
      `, {
        headers: {
          "content-type": "text/html;charset=UTF-8"
        }
      });
    }

    // =========================
    // PUBLISH POST
    // =========================
    if (url.pathname === "/publish" && request.method === "POST") {
      try {
        const formData = await request.formData();

        const message =
          String(formData.get("message") || "").trim();

        const selectedPageIds = formData
          .getAll("page_ids")
          .map(id => String(id))
          .filter(Boolean);

        const image = formData.get("image");

        if (!selectedPageIds.length) {
          return htmlResult(
            "No Pages Selected",
            "Please select at least one Facebook Page.",
            true
          );
        }

        if (!message && !(image instanceof File)) {
          return htmlResult(
            "Post Empty",
            "Please enter post text or select an image.",
            true
          );
        }

        // Get selected pages from database
        const placeholders =
          selectedPageIds.map(() => "?").join(",");

        const pagesResult = await env.DB.prepare(`
          SELECT
            page_id,
            page_name,
            page_access_token
          FROM facebook_pages
          WHERE page_id IN (${placeholders})
        `)
          .bind(...selectedPageIds)
          .all();

        const pages = pagesResult.results || [];

        const results = [];

        // =========================
        // PUBLISH TO EACH PAGE
        // =========================
        for (const page of pages) {
          try {
            let graphResponse;
            let graphData;

            // =========================
            // IMAGE POST
            // =========================
            if (image instanceof File && image.size > 0) {
              const uploadData = new FormData();

              uploadData.append(
                "source",
                image,
                image.name || "image.jpg"
              );

              if (message) {
                uploadData.append("message", message);
              }

              uploadData.append("published", "true");

              uploadData.append(
                "access_token",
                page.page_access_token
              );

              graphResponse = await fetch(
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/photos`,
                {
                  method: "POST",
                  body: uploadData
                }
              );

              graphData = await graphResponse.json();
            }

            // =========================
            // TEXT ONLY POST
            // =========================
            else {
              const postData = new URLSearchParams();

              postData.set("message", message);

              postData.set(
                "access_token",
                page.page_access_token
              );

              graphResponse = await fetch(
                `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/feed`,
                {
                  method: "POST",
                  headers: {
                    "content-type":
                      "application/x-www-form-urlencoded"
                  },
                  body: postData
                }
              );

              graphData = await graphResponse.json();
            }

            if (!graphResponse.ok || graphData.error) {
              results.push({
                page_name: page.page_name,
                success: false,
                message:
                  graphData?.error?.message ||
                  "Facebook publishing failed."
              });
            } else {
              results.push({
                page_name: page.page_name,
                success: true,
                message:
                  "Published successfully."
              });
            }

          } catch (error) {
            results.push({
              page_name: page.page_name,
              success: false,
              message: error.message || "Unknown error."
            });
          }
        }

        return publishResultsPage(results);

      } catch (error) {
        return htmlResult(
          "Publishing Error",
          error.message || "Unknown publishing error.",
          true
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
};


// =========================
// PUBLISH RESULTS PAGE
// =========================
function publishResultsPage(results) {
  const successCount =
    results.filter(result => result.success).length;

  const failedCount =
    results.filter(result => !result.success).length;

  const rows = results
    .map(
      result => `
        <tr>
          <td>${result.success ? "✅" : "❌"}</td>
          <td>${escapeHtml(result.page_name)}</td>
          <td>${escapeHtml(result.message)}</td>
        </tr>
      `
    )
    .join("");

  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Publish Results</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">

      <style>
        body {
          font-family: Arial;
          padding: 30px;
          background: #f5f7fb;
        }

        .box {
          background: white;
          padding: 25px;
          border-radius: 12px;
          max-width: 1000px;
          margin: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 20px;
        }

        th, td {
          padding: 10px;
          border-bottom: 1px solid #ddd;
          text-align: left;
        }

        th {
          background: #f0f2f5;
        }

        a {
          display: inline-block;
          margin-top: 20px;
          background: #1877f2;
          color: white;
          padding: 12px 18px;
          border-radius: 8px;
          text-decoration: none;
        }
      </style>
    </head>

    <body>
      <div class="box">

        <h2>Publish Results</h2>

        <p>
          ✅ Successful:
          <strong>${successCount}</strong>
        </p>

        <p>
          ❌ Failed:
          <strong>${failedCount}</strong>
        </p>

        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Page</th>
              <th>Result</th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>

        <a href="/">← Back to Dashboard</a>

      </div>
    </body>
    </html>
  `, {
    headers: {
      "content-type": "text/html;charset=UTF-8"
    }
  });
}


// =========================
// GENERIC RESULT PAGE
// =========================
function htmlResult(title, message, isError = false) {
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(title)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>

    <body style="font-family:Arial;padding:30px">

      <h2>${isError ? "❌" : "✅"} ${escapeHtml(title)}</h2>

      <p>${escapeHtml(message)}</p>

      <p>
        <a href="/">← Back to Dashboard</a>
      </p>

    </body>
    </html>
  `, {
    status: isError ? 400 : 200,
    headers: {
      "content-type": "text/html;charset=UTF-8"
    }
  });
}


// =========================
// HTML ESCAPE
// =========================
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
