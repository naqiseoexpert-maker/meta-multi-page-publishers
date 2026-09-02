export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // HOME
    // =========================
    if (url.pathname === "/") {
      const pages = await env.DB.prepare(`
        SELECT
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

            a.button {
              display: inline-block;
              background: #1877f2;
              color: white;
              padding: 12px 18px;
              border-radius: 8px;
              text-decoration: none;
              margin-bottom: 20px;
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
                  <table>
                    <thead>
                      <tr>
                        <th>Page Name</th>
                        <th>Page ID</th>
                        <th>Facebook Account</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${pageRows}
                    </tbody>
                  </table>
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

    return new Response("Not found", { status: 404 });
  }
};


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
