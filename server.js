export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Home
    if (url.pathname === "/") {
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Meta Multi Page Publisher</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family:Arial;padding:30px">
          <h2>Meta Multi Page Publisher</h2>
          <p>Cloudflare Worker is working ✅</p>
          <a href="/auth/meta">Connect with Facebook</a>
        </body>
        </html>
      `, {
        headers: {
          "content-type": "text/html;charset=UTF-8"
        }
      });
    }

    // Start Facebook login
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

    // Facebook OAuth callback
    if (url.pathname === "/auth/meta/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription =
        url.searchParams.get("error_description");

      if (error) {
        return new Response(
          `Facebook login failed: ${errorDescription || error}`,
          { status: 400 }
        );
      }

      if (!code) {
        return new Response("Missing Facebook authorization code.", {
          status: 400
        });
      }

      const redirectUri =
        `${url.origin}/auth/meta/callback`;

      // Exchange authorization code for user access token
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
          `<pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre>`,
          {
            status: 400,
            headers: {
              "content-type": "text/html;charset=UTF-8"
            }
          }
        );
      }

      const userAccessToken = tokenData.access_token;

      // Get Facebook Pages available to this user
      const pagesUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
        `?fields=id,name,access_token` +
        `&access_token=${encodeURIComponent(userAccessToken)}`;

      const pagesResponse = await fetch(pagesUrl);
      const pagesData = await pagesResponse.json();

      if (!pagesResponse.ok || pagesData.error) {
        return new Response(
          `<pre>${escapeHtml(JSON.stringify(pagesData, null, 2))}</pre>`,
          {
            status: 400,
            headers: {
              "content-type": "text/html;charset=UTF-8"
            }
          }
        );
      }

      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Connected Facebook Pages</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family:Arial;padding:30px">
          <h2>Facebook Connected ✅</h2>
          <p>Pages found: ${pagesData.data?.length || 0}</p>

          <pre style="white-space:pre-wrap;background:#f5f5f5;padding:15px;border-radius:8px">${escapeHtml(
            JSON.stringify(
              (pagesData.data || []).map(page => ({
                id: page.id,
                name: page.name,
                has_access_token: Boolean(page.access_token)
              })),
              null,
              2
            )
          )}</pre>
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
