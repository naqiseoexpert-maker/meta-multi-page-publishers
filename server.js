export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    if (url.pathname === "/auth/meta") {
      const redirectUri = `${url.origin}/auth/meta/callback`;

      const facebookUrl =
        `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth` +
        `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=pages_show_list,pages_read_engagement,pages_manage_posts`;

      return Response.redirect(facebookUrl, 302);
    }

    return new Response("Not found", { status: 404 });
  }
};
