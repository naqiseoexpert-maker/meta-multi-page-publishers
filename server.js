const APP_NAME = "Meta Multi Page Publisher";

export default {
  async fetch(request, env) {
    try {
      await ensureDatabaseSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/login") {
        if (await isAuthenticated(request, env)) {
          return Response.redirect(url.origin + "/", 302);
        }
        return showLoginPage("");
      }

      if (request.method === "POST" && path === "/login") {
        return handleLogin(request, env);
      }

      if (!(await isAuthenticated(request, env))) {
        return showLoginPage("");
      }

      if (request.method === "GET" && path === "/") {
        return showDashboard(env);
      }

      if (request.method === "GET" && path === "/auth/meta") {
        return startMetaLogin(request, env);
      }

      if (request.method === "GET" && path === "/auth/meta/callback") {
        return metaCallback(request, env);
      }

      if (request.method === "POST" && path === "/sync") {
        return syncPages(request, env);
      }

      if (request.method === "POST" && path === "/remove-account") {
        return removeAccount(request, env);
      }

      if (request.method === "POST" && path === "/publish") {
        return publishPost(request, env);
      }

      if (request.method === "POST" && path === "/logout") {
        return handleLogout();
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

      return page(
        "Error",
        '<div class="error-box">' +
          "<h2>Something went wrong</h2>" +
          "<pre>" +
          escapeHtml(
            error && (error.stack || error.message)
              ? error.stack || error.message
              : String(error)
          ) +
          "</pre>" +
          '<a class="back-btn" href="/">Back to Dashboard</a>' +
        "</div>"
      );
    }
  }
};

async function isAuthenticated(request, env) {
  const password = String(env.PUBLISHER_PASSWORD || "").trim();

  if (!password) {
    throw new Error(
      "PUBLISHER_PASSWORD secret is missing. Add it in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  const cookies = parseCookies(
    request.headers.get("Cookie") || ""
  );

  if (!cookies.mp_auth) {
    return false;
  }

  const expected = await createAuthToken(password);

  return safeEqual(cookies.mp_auth, expected);
}

async function createAuthToken(password) {
  const data = new TextEncoder().encode(
    "meta-multi-page-publisher:" + password
  );

  const hash = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return arrayBufferToHex(hash);
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
}

function safeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function parseCookies(header) {
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function showLoginPage(errorMessage) {
  const errorHtml = errorMessage
    ? '<div class="login-error">' +
      escapeHtml(errorMessage) +
      "</div>"
    : "";

  return page(
    "Password Required",
    '<div class="login-wrapper">' +
      '<div class="login-card">' +
        '<div class="login-logo">🔐</div>' +
        "<h1>" +
          escapeHtml(APP_NAME) +
        "</h1>" +
        "<p>Enter your password to continue.</p>" +
        errorHtml +
        '<form method="POST" action="/login">' +
          '<input type="password" name="password" placeholder="Enter password" autocomplete="current-password" required autofocus />' +
          '<button type="submit" class="login-btn">Login</button>' +
        "</form>" +
      "</div>" +
    "</div>"
  );
}

async function handleLogin(request, env) {
  const configuredPassword = String(
    env.PUBLISHER_PASSWORD || ""
  ).trim();

  if (!configuredPassword) {
    return showLoginPage(
      "PUBLISHER_PASSWORD secret is not configured."
    );
  }

  const form = await request.formData();
  const password = String(
    form.get("password") || ""
  );

  if (
    !password ||
    password !== configuredPassword
  ) {
    return showLoginPage(
      "Incorrect password. Please try again."
    );
  }

  const token = await createAuthToken(
    configuredPassword
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "mp_auth=" +
        token +
        "; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store"
    }
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie":
        "mp_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store"
    }
  });
}

async function ensureDatabaseSchema(db) {
  if (!db) {
    throw new Error(
      "D1 database binding DB is missing. Check wrangler.toml and Cloudflare Worker Bindings."
    );
  }

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS accounts (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "facebook_user_id TEXT NOT NULL UNIQUE, " +
      "account_name TEXT, " +
      "access_token TEXT NOT NULL, " +
      "created_at TEXT DEFAULT (datetime('now'))" +
    ")"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS pages (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "facebook_page_id TEXT NOT NULL UNIQUE, " +
      "page_name TEXT, " +
      "access_token TEXT NOT NULL, " +
      "account_id INTEGER NOT NULL, " +
      "created_at TEXT DEFAULT (datetime('now'))" +
    ")"
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_pages_account_id " +
    "ON pages(account_id)"
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_pages_page_id " +
    "ON pages(facebook_page_id)"
  ).run();
}

function getMetaConfig(env) {
  const appId = String(
    env.META_APP_ID || ""
  ).trim();

  const appSecret = String(
    env.META_APP_SECRET || ""
  ).trim();

  const graphVersion = String(
    env.META_GRAPH_VERSION || ""
  ).trim();

  const missing = [];

  if (!appId) {
    missing.push("META_APP_ID");
  }

  if (!appSecret) {
    missing.push("META_APP_SECRET");
  }

  if (!graphVersion) {
    missing.push("META_GRAPH_VERSION");
  }

  if (missing.length > 0) {
    throw new Error(
      "Meta configuration is missing: " +
      missing.join(", ") +
      ". Check Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  return {
    appId: appId,
    appSecret: appSecret,
    graphVersion: graphVersion
  };
}

async function showDashboard(env) {
  const accountsResult = await env.DB.prepare(
    "SELECT id, facebook_user_id, account_name, created_at " +
    "FROM accounts ORDER BY id ASC"
  ).all();

  const accounts =
    accountsResult.results || [];

  const pagesResult = await env.DB.prepare(
    "SELECT id, facebook_page_id, page_name, account_id " +
    "FROM pages " +
    "ORDER BY account_id ASC, page_name COLLATE NOCASE ASC"
  ).all();

  const pages =
    pagesResult.results || [];

  const groupedPages = {};

  for (const account of accounts) {
    groupedPages[account.id] = [];
  }

  for (const p of pages) {
    if (!groupedPages[p.account_id]) {
      groupedPages[p.account_id] = [];
    }

    groupedPages[p.account_id].push(p);
  }

  let accountHtml = "";

  if (accounts.length === 0) {
    accountHtml =
      '<div class="empty-box">' +
        "<h3>No Facebook account connected</h3>" +
        "<p>Connect your Facebook account to load your Pages.</p>" +
      "</div>";
  } else {
    for (const account of accounts) {
      const accountPages =
        groupedPages[account.id] || [];

      let pageHtml = "";

      if (accountPages.length > 0) {
        pageHtml =
          '<div class="list-toolbar">' +
            "<strong>Select Pages</strong>" +
            '<div class="select-actions">' +
              '<button type="button" class="small-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',true)">Select All</button>' +
              '<button type="button" class="small-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',false)">Unselect All</button>' +
            "</div>" +
          "</div>" +
          '<div class="page-list">';

        for (const p of accountPages) {
          pageHtml +=
            '<label class="page-row">' +
              '<input class="page-checkbox account-' +
                Number(account.id) +
                '" type="checkbox" name="page_ids" value="' +
                escapeHtml(p.id) +
                '" data-page-id="' +
                escapeHtml(p.facebook_page_id) +
                '" form="publish-form" />' +

              '<div class="page-info">' +
                '<div class="page-name">' +
                  escapeHtml(
                    p.page_name ||
                    "Unnamed Page"
                  ) +
                "</div>" +

                '<div class="page-id">' +
                  "Page ID: " +
                  "<code>" +
                    escapeHtml(
                      p.facebook_page_id
                    ) +
                  "</code>" +
                "</div>" +
              "</div>" +
            "</label>";
        }

        pageHtml += "</div>";
      } else {
        pageHtml =
          '<div class="no-pages">' +
            "No Pages found for this account. " +
            "Click <strong>Sync Pages</strong> to refresh." +
          "</div>";
      }

      accountHtml +=
        '<section class="account-card">' +
          '<div class="account-header">' +

            "<div>" +
              "<h2>" +
                escapeHtml(
                  account.account_name ||
                  "Facebook Account"
                ) +
              "</h2>" +

              '<div class="facebook-id">' +
                "Facebook ID: " +
                "<code>" +
                  escapeHtml(
                    account.facebook_user_id
                  ) +
                "</code>" +
              "</div>" +

              '<div class="page-count">' +
                accountPages.length +
                " Connected Page" +
                (
                  accountPages.length === 1
                    ? ""
                    : "s"
                ) +
              "</div>" +
            "</div>" +

            '<div class="account-actions">' +

              '<form method="POST" action="/sync">' +
                '<input type="hidden" name="account_id" value="' +
                  escapeHtml(account.id) +
                '" />' +
                '<button class="btn btn-blue" type="submit">' +
                  "Sync Pages" +
                "</button>" +
              "</form>" +

              '<form method="POST" action="/remove-account" onsubmit="return confirm(\'Remove this Facebook account and all its connected Pages?\');">' +
                '<input type="hidden" name="account_id" value="' +
                  escapeHtml(account.id) +
                '" />' +
                '<button class="btn btn-red" type="submit">' +
                  "Remove" +
                "</button>" +
              "</form>" +

            "</div>" +

          "</div>" +

          '<div class="pages-section">' +
            pageHtml +
          "</div>" +

        "</section>";
    }
  }

  let publisherHtml = "";

  if (
    accounts.length > 0 &&
    pages.length > 0
  ) {
    publisherHtml =
      '<section class="publisher-card">' +

        '<div class="publisher-header">' +
          "<h2>Create Post</h2>" +
          '<div id="selected-count">0 Pages Selected</div>' +
        "</div>" +

        '<form id="publish-form" method="POST" action="/publish" enctype="multipart/form-data">' +

          '<div class="field">' +
            '<label for="message">Post Text</label>' +
            '<textarea id="message" name="message" rows="7" placeholder="Write your post..."></textarea>' +
          "</div>" +

          '<div class="field">' +
            '<label for="media">Image / Video</label>' +
            '<input id="media" type="file" name="media" accept="image/*,video/*" />' +
            '<div class="hint">Leave empty for a text-only post.</div>' +
          "</div>" +

          '<button class="publish-btn" type="submit" onclick="return validatePublish()">' +
            "Publish to Selected Pages" +
          "</button>" +

        "</form>" +

      "</section>";
  }

  const script =
    "<script>" +

      "function updateSelectedCount(){" +
        "const checked=document.querySelectorAll('.page-checkbox:checked');" +
        "const counter=document.getElementById('selected-count');" +
        "if(counter){" +
          "counter.textContent=checked.length+' Page'+(checked.length===1?'':'s')+' Selected';" +
        "}" +
      "}" +

      "function selectAccountPages(accountId,select){" +
        "document.querySelectorAll('.account-'+accountId).forEach(function(c){" +
          "c.checked=select;" +
        "});" +
        "updateSelectedCount();" +
      "}" +

      "document.addEventListener('change',function(e){" +
        "if(e.target&&e.target.classList.contains('page-checkbox')){" +
          "updateSelectedCount();" +
        "}" +
      "});" +

      "function validatePublish(){" +
        "const selected=document.querySelectorAll('.page-checkbox:checked');" +

        "if(!selected.length){" +
          "alert('Please select at least one Page.');" +
          "return false;" +
        "}" +

        "const message=document.getElementById('message').value.trim();" +
        "const media=document.getElementById('media').files.length;" +

        "if(!message&&!media){" +
          "alert('Please enter post text or select an image/video.');" +
          "return false;" +
        "}" +

        "return true;" +
      "}" +

      "updateSelectedCount();" +

    "</script>";

  return page(
    APP_NAME,
    '<div class="topbar">' +

      "<div>" +
        '<div class="brand">' +
          escapeHtml(APP_NAME) +
        "</div>" +

        '<div class="subtitle">' +
          "Publish to multiple Facebook Pages" +
        "</div>" +
      "</div>" +

      '<div class="top-actions">' +

        '<a class="connect-btn" href="/auth/meta">' +
          "+ Connect Facebook Account" +
        "</a>" +

        '<form method="POST" action="/logout" class="logout-form">' +
          '<button class="logout-btn" type="submit">Logout</button>' +
        "</form>" +

      "</div>" +

    "</div>" +

    '<div class="container">' +
      accountHtml +
      publisherHtml +
    "</div>" +

    script
  );
}

function startMetaLogin(request, env) {
  let config;

  try {
    config = getMetaConfig(env);
  } catch (error) {
    return page(
      "Meta Configuration Error",
      '<div class="error-box">' +
        "<h2>Meta Configuration Error</h2>" +
        "<pre>" +
          escapeHtml(error.message) +
        "</pre>" +
        '<a class="back-btn" href="/">Back to Dashboard</a>' +
      "</div>"
    );
  }

  const requestUrl =
    new URL(request.url);

  const redirectUri =
    requestUrl.origin +
    "/auth/meta/callback";

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const loginUrl =
    "https://www.facebook.com/" +
    config.graphVersion +
    "/dialog/oauth" +
    "?client_id=" +
    encodeURIComponent(config.appId) +
    "&redirect_uri=" +
    encodeURIComponent(redirectUri) +
    "&scope=" +
    encodeURIComponent(scope);

  return Response.redirect(
    loginUrl,
    302
  );
}

async function metaCallback(request, env) {
  const config =
    getMetaConfig(env);

  const url =
    new URL(request.url);

  const code =
    url.searchParams.get("code");

  const error =
    url.searchParams.get("error");

  const errorDescription =
    url.searchParams.get(
      "error_description"
    );

  if (error) {
    return page(
      "Facebook Login Error",
      '<div class="error-box">' +
        "<h2>Facebook Login Error</h2>" +
        "<p>" +
          escapeHtml(error) +
        "</p>" +
        "<p>" +
          escapeHtml(
            errorDescription || ""
          ) +
        "</p>" +
        '<a class="back-btn" href="/">Back to Dashboard</a>' +
      "</div>"
    );
  }

  if (!code) {
    return page(
      "Facebook Login Error",
      '<div class="error-box">' +
        "<h2>No authorization code received.</h2>" +
        '<a class="back-btn" href="/">Back to Dashboard</a>' +
      "</div>"
    );
  }

  const redirectUri =
    url.origin +
    "/auth/meta/callback";

  const tokenUrl =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/oauth/access_token" +
    "?client_id=" +
    encodeURIComponent(config.appId) +
    "&client_secret=" +
    encodeURIComponent(config.appSecret) +
    "&redirect_uri=" +
    encodeURIComponent(redirectUri) +
    "&code=" +
    encodeURIComponent(code);

  const tokenResponse =
    await fetch(tokenUrl);

  const tokenData =
    await readGraphResponse(
      tokenResponse
    );

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    throw new Error(
      "Facebook token exchange failed: " +
      JSON.stringify(tokenData)
    );
  }

  const userAccessToken =
    tokenData.access_token;

  const userUrl =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/me" +
    "?fields=id,name" +
    "&access_token=" +
    encodeURIComponent(
      userAccessToken
    );

  const userResponse =
    await fetch(userUrl);

  const userData =
    await readGraphResponse(
      userResponse
    );

  if (
    !userResponse.ok ||
    !userData.id
  ) {
    throw new Error(
      "Could not get Facebook account information: " +
      JSON.stringify(userData)
    );
  }

  await env.DB.prepare(
    "INSERT INTO accounts (" +
      "facebook_user_id, account_name, access_token" +
    ") VALUES (?, ?, ?) " +
    "ON CONFLICT(facebook_user_id) DO UPDATE SET " +
      "account_name = excluded.account_name, " +
      "access_token = excluded.access_token"
  )
    .bind(
      String(userData.id),
      userData.name ||
        "Facebook Account",
      userAccessToken
    )
    .run();

  const account =
    await env.DB.prepare(
      "SELECT id FROM accounts " +
      "WHERE facebook_user_id = ?"
    )
      .bind(String(userData.id))
      .first();

  if (!account) {
    throw new Error(
      "Facebook account was saved but could not be found."
    );
  }

  await syncAccountPages(
    env,
    Number(account.id),
    userAccessToken,
    config.graphVersion
  );

  return Response.redirect(
    url.origin + "/",
    302
  );
}

async function syncPages(request, env) {
  const form =
    await request.formData();

  const accountId =
    Number(form.get("account_id"));

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  const account =
    await env.DB.prepare(
      "SELECT id, access_token " +
      "FROM accounts WHERE id = ?"
    )
      .bind(accountId)
      .first();

  if (!account) {
    throw new Error(
      "Facebook account not found."
    );
  }

  const config =
    getMetaConfig(env);

  await syncAccountPages(
    env,
    account.id,
    account.access_token,
    config.graphVersion
  );

  return Response.redirect(
    "/",
    303
  );
}

async function syncAccountPages(
  env,
  accountId,
  userAccessToken,
  graphVersion
) {
  let nextUrl =
    "https://graph.facebook.com/" +
    graphVersion +
    "/me/accounts" +
    "?fields=id,name,access_token" +
    "&limit=100" +
    "&access_token=" +
    encodeURIComponent(
      userAccessToken
    );

  const foundPageIds = [];

  while (nextUrl) {
    const response =
      await fetch(nextUrl);

    const data =
      await readGraphResponse(
        response
      );

    if (!response.ok) {
      throw new Error(
        "Could not load Facebook Pages: " +
        JSON.stringify(data)
      );
    }

    const pageList =
      data.data || [];

    for (const fbPage of pageList) {
      if (
        !fbPage.id ||
        !fbPage.access_token
      ) {
        continue;
      }

      foundPageIds.push(
        String(fbPage.id)
      );

      await env.DB.prepare(
        "INSERT INTO pages (" +
          "facebook_page_id, page_name, access_token, account_id" +
        ") VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(facebook_page_id) DO UPDATE SET " +
          "page_name = excluded.page_name, " +
          "access_token = excluded.access_token, " +
          "account_id = excluded.account_id"
      )
        .bind(
          String(fbPage.id),
          fbPage.name ||
            "Unnamed Page",
          fbPage.access_token,
          Number(accountId)
        )
        .run();
    }

    nextUrl =
      data.paging &&
      data.paging.next
        ? data.paging.next
        : null;
  }

  if (foundPageIds.length > 0) {
    const placeholders =
      foundPageIds
        .map(function () {
          return "?";
        })
        .join(",");

    await env.DB.prepare(
      "DELETE FROM pages " +
      "WHERE account_id = ? " +
      "AND facebook_page_id NOT IN (" +
      placeholders +
      ")"
    )
      .bind(
        Number(accountId),
        ...foundPageIds
      )
      .run();
  } else {
    await env.DB.prepare(
      "DELETE FROM pages " +
      "WHERE account_id = ?"
    )
      .bind(Number(accountId))
      .run();
  }
}

async function removeAccount(
  request,
  env
) {
  const form =
    await request.formData();

  const accountId =
    Number(form.get("account_id"));

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  await env.DB.prepare(
    "DELETE FROM pages WHERE account_id = ?"
  )
    .bind(accountId)
    .run();

  await env.DB.prepare(
    "DELETE FROM accounts WHERE id = ?"
  )
    .bind(accountId)
    .run();

  return Response.redirect(
    "/",
    303
  );
}

async function publishPost(
  request,
  env
) {
  const form =
    await request.formData();

  const message =
    String(
      form.get("message") || ""
    ).trim();

  const selectedPageIds =
    form.getAll("page_ids");

  const media =
    form.get("media");

  if (!selectedPageIds.length) {
    return page(
      "No Pages Selected",
      '<div class="error-box">' +
        "<h2>No Pages Selected</h2>" +
        "<p>Please select at least one Facebook Page.</p>" +
        '<a class="back-btn" href="/">Back</a>' +
      "</div>"
    );
  }

  if (
    !message &&
    (!media || !media.name)
  ) {
    return page(
      "Empty Post",
      '<div class="error-box">' +
        "<h2>Empty Post</h2>" +
        "<p>Enter text or select an image/video.</p>" +
        '<a class="back-btn" href="/">Back</a>' +
      "</div>"
    );
  }

  const numericPageIds =
    selectedPageIds
      .map(function (id) {
        return Number(id);
      })
      .filter(function (id) {
        return (
          Number.isInteger(id) &&
          id > 0
        );
      });

  if (!numericPageIds.length) {
    throw new Error(
      "Invalid selected Page IDs."
    );
  }

  const placeholders =
    numericPageIds
      .map(function () {
        return "?";
      })
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, access_token " +
      "FROM pages " +
      "WHERE id IN (" +
      placeholders +
      ") " +
      "ORDER BY page_name COLLATE NOCASE ASC"
    )
      .bind(...numericPageIds)
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    throw new Error(
      "Selected Pages were not found in the database."
    );
  }

  const config =
    getMetaConfig(env);

  let mediaBuffer = null;
  let mediaType = null;
  let mediaName = null;

  if (
    media &&
    typeof media === "object" &&
    media.name
  ) {
    mediaName = media.name;

    const contentType =
      media.type || "";

    if (
      contentType.startsWith(
        "image/"
      )
    ) {
      mediaType = "image";
    } else if (
      contentType.startsWith(
        "video/"
      )
    ) {
      mediaType = "video";
    } else {
      const lower =
        mediaName.toLowerCase();

      if (
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".png") ||
        lower.endsWith(".gif") ||
        lower.endsWith(".webp")
      ) {
        mediaType = "image";
      } else if (
        lower.endsWith(".mp4") ||
        lower.endsWith(".mov") ||
        lower.endsWith(".avi") ||
        lower.endsWith(".mkv") ||
        lower.endsWith(".webm")
      ) {
        mediaType = "video";
      }
    }

    if (!mediaType) {
      throw new Error(
        "Unsupported media type. Please upload an image or video."
      );
    }

    mediaBuffer =
      await media.arrayBuffer();

    if (
      mediaBuffer.byteLength >
      100 * 1024 * 1024
    ) {
      throw new Error(
        "File is too large. Please use a smaller file."
      );
    }
  }

  const results = [];

  for (const fbPage of pages) {
    try {
      let result;

      if (!mediaBuffer) {
        result =
          await publishTextPost(
            fbPage,
            message,
            config.graphVersion
          );
      } else if (
        mediaType === "image"
      ) {
        result =
          await publishImagePost(
            fbPage,
            message,
            mediaBuffer,
            mediaName,
            config.graphVersion
          );
      } else {
        result =
          await publishVideoPost(
            fbPage,
            message,
            mediaBuffer,
            mediaName,
            config.graphVersion
          );
      }

      results.push({
        page: fbPage.page_name,
        pageId:
          fbPage.facebook_page_id,
        success: true,
        postId:
          result && result.id
            ? result.id
            : ""
      });
    } catch (error) {
      results.push({
        page: fbPage.page_name,
        pageId:
          fbPage.facebook_page_id,
        success: false,
        error:
          error && error.message
            ? error.message
            : String(error)
      });
    }
  }

  let resultsHtml = "";

  for (const r of results) {
    resultsHtml +=
      '<div class="result-row ' +
      (
        r.success
          ? "result-success"
          : "result-failed"
      ) +
      '">' +

        "<div>" +
          "<strong>" +
            escapeHtml(
              r.page ||
              "Unnamed Page"
            ) +
          "</strong>" +

          '<div class="result-page-id">' +
            "Page ID: " +
            escapeHtml(
              r.pageId
            ) +
          "</div>" +
        "</div>" +

        '<div class="result-status">' +
          (
            r.success
              ? "✓ Published"
              : "✕ Failed"
          ) +
        "</div>" +

        (
          r.success
            ? (
                r.postId
                  ? '<div class="result-error">Post ID: ' +
                    escapeHtml(
                      r.postId
                    ) +
                    "</div>"
                  : ""
              )
            : '<div class="result-error">' +
              escapeHtml(
                r.error || ""
              ) +
              "</div>"
        ) +

      "</div>";
  }

  const successCount =
    results.filter(function (r) {
      return r.success;
    }).length;

  return page(
    "Publish Results",
    '<div class="results-card">' +
      "<h2>Publish Results</h2>" +

      '<div class="result-summary">' +
        successCount +
        " successful / " +
        results.length +
        " total" +
      "</div>" +

      '<div class="results-list">' +
        resultsHtml +
      "</div>" +

      '<a class="back-btn" href="/">Back to Dashboard</a>' +
    "</div>"
  );
}

async function publishTextPost(
  fbPage,
  message,
  graphVersion
) {
  const url =
    "https://graph.facebook.com/" +
    graphVersion +
    "/" +
    fbPage.facebook_page_id +
    "/feed";

  const body =
    new URLSearchParams();

  body.set(
    "message",
    message
  );

  body.set(
    "access_token",
    fbPage.access_token
  );

  return graphPost(
    url,
    body
  );
}

async function publishImagePost(
  fbPage,
  message,
  mediaBuffer,
  mediaName,
  graphVersion
) {
  const url =
    "https://graph.facebook.com/" +
    graphVersion +
    "/" +
    fbPage.facebook_page_id +
    "/photos";

  const form =
    new FormData();

  form.append(
    "access_token",
    fbPage.access_token
  );

  if (message) {
    form.append(
      "caption",
      message
    );
  }

  form.append(
    "source",
    new File(
      [mediaBuffer],
      mediaName || "image.jpg"
    )
  );

  return graphPostFormData(
    url,
    form
  );
}

async function publishVideoPost(
  fbPage,
  message,
  mediaBuffer,
  mediaName,
  graphVersion
) {
  const url =
    "https://graph.facebook.com/" +
    graphVersion +
    "/" +
    fbPage.facebook_page_id +
    "/videos";

  const form =
    new FormData();

  form.append(
    "access_token",
    fbPage.access_token
  );

  if (message) {
    form.append(
      "description",
      message
    );
  }

  form.append(
    "source",
    new File(
      [mediaBuffer],
      mediaName || "video.mp4"
    )
  );

  return graphPostFormData(
    url,
    form
  );
}

async function graphPost(
  url,
  body
) {
  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: body
    });

  const data =
    await readGraphResponse(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      formatGraphError(data)
    );
  }

  return data;
}

async function graphPostFormData(
  url,
  form
) {
  const response =
    await fetch(url, {
      method: "POST",
      body: form
    });

  const data =
    await readGraphResponse(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      formatGraphError(data)
    );
  }

  return data;
}

async function readGraphResponse(
  response
) {
  const text =
    await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      error: {
        message:
          text ||
          (
            "Facebook returned HTTP " +
            response.status
          ),
        type: "NonJSONResponse",
        code: response.status
      }
    };
  }
}

function formatGraphError(data) {
  if (
    data &&
    data.error
  ) {
    const e =
      data.error;

    return [
      e.message ||
        "Facebook Graph API error",

      e.type
        ? "Type: " + e.type
        : "",

      e.code !== undefined
        ? "Code: " + e.code
        : "",

      e.error_subcode !== undefined
        ? "Subcode: " +
          e.error_subcode
        : ""
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return JSON.stringify(data);
}

function page(
  title,
  content
) {
  const css =
    `*{box-sizing:border-box}
body{margin:0;background:#f4f7fb;color:#172033;font-family:Arial,Helvetica,sans-serif}
.topbar{background:#fff;border-bottom:1px solid #e2e7ef;padding:20px 30px;display:flex;justify-content:space-between;align-items:center;gap:20px;position:sticky;top:0;z-index:20}
.brand{font-size:23px;font-weight:800}
.subtitle{margin-top:4px;color:#687386;font-size:13px}
.top-actions{display:flex;align-items:center;gap:8px}
.connect-btn{display:inline-flex;align-items:center;justify-content:center;background:#1877f2;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700}
.logout-form{margin:0}
.logout-btn{border:1px solid #dfe4eb;background:#fff;color:#455066;border-radius:8px;padding:11px 14px;font-weight:700;cursor:pointer}
.container{max-width:1100px;margin:30px auto;padding:0 18px 60px}
.account-card,.publisher-card,.results-card,.empty-box,.error-box{background:#fff;border:1px solid #e1e6ee;border-radius:14px;box-shadow:0 5px 20px rgba(20,30,50,.05);margin-bottom:24px}
.account-card{overflow:hidden}
.account-header{padding:22px;display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #edf0f5}
.account-header h2{margin:0 0 8px;font-size:20px}
.facebook-id{color:#697589;font-size:13px;margin-bottom:8px}
code{background:#f0f3f7;padding:3px 6px;border-radius:5px;font-size:12px;color:#27344a;word-break:break-all}
.page-count{display:inline-block;background:#eef5ff;color:#1769d2;font-weight:700;font-size:13px;padding:6px 10px;border-radius:20px}
.account-actions{display:flex;gap:8px;align-items:center}
.account-actions form{margin:0}
.btn{border:0;border-radius:7px;padding:10px 14px;cursor:pointer;font-weight:700}
.btn-blue{background:#1877f2;color:#fff}
.btn-red{background:#fff0f0;color:#d32f2f;border:1px solid #ffd1d1}
.pages-section{padding:20px 22px 24px}
.list-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:15px}
.select-actions{display:flex;gap:7px}
.small-btn{background:#f4f6f9;color:#27344a;border:1px solid #dfe4eb;border-radius:6px;padding:7px 10px;cursor:pointer;font-size:12px;font-weight:700}
.page-list{display:flex;flex-direction:column;gap:8px}
.page-row{display:flex;align-items:center;gap:14px;min-height:68px;padding:13px 15px;background:#fafbfd;border:1px solid #e5e9f0;border-radius:9px;cursor:pointer}
.page-row:hover{background:#f5f9ff;border-color:#b8d3f7}
.page-checkbox{width:19px;height:19px;flex:0 0 auto;cursor:pointer}
.page-info{min-width:0;flex:1}
.page-name{font-size:15px;font-weight:700;margin-bottom:6px;color:#1c2738}
.page-id{font-size:12px;color:#758095}
.page-id code{background:transparent;padding:0;color:#687386}
.no-pages{padding:20px;background:#f8fafc;border-radius:8px;color:#697589;text-align:center}
.publisher-card{padding:24px}
.publisher-header{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:22px}
.publisher-header h2{margin:0}
#selected-count{background:#eef5ff;color:#1769d2;border-radius:20px;padding:7px 11px;font-size:13px;font-weight:700}
.field{margin-bottom:20px}
.field label{display:block;font-weight:700;margin-bottom:8px}
textarea{width:100%;resize:vertical;border:1px solid #dce2eb;border-radius:8px;padding:13px;font:inherit;outline:none}
textarea:focus{border-color:#1877f2;box-shadow:0 0 0 3px rgba(24,119,242,.1)}
input[type=file]{width:100%;border:1px solid #dce2eb;border-radius:8px;padding:11px;background:#fff}
.hint{color:#7a8495;font-size:12px;margin-top:7px}
.publish-btn{width:100%;border:0;background:#1877f2;color:#fff;padding:14px;border-radius:9px;font-size:15px;font-weight:800;cursor:pointer}
.empty-box,.error-box,.results-card{padding:28px}
.error-box{max-width:900px;margin:50px auto}
.error-box h2{margin-top:0}
pre{background:#f5f6f8;padding:15px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.back-btn{display:inline-block;margin-top:20px;padding:11px 16px;background:#1877f2;color:#fff;text-decoration:none;border-radius:7px;font-weight:700}
.result-summary{margin:12px 0 20px;font-weight:700;color:#536075}
.results-list{display:flex;flex-direction:column;gap:9px}
.result-row{border:1px solid #e1e6ee;border-radius:9px;padding:14px;display:grid;grid-template-columns:1fr auto;gap:8px 15px}
.result-success{background:#f6fff8;border-color:#cdebd5}
.result-failed{background:#fff8f8;border-color:#f1d0d0}
.result-page-id{margin-top:5px;color:#7b8596;font-size:12px}
.result-status{font-weight:800}
.result-success .result-status{color:#218838}
.result-failed .result-status{color:#d32f2f}
.result-error{grid-column:1 / -1;color:#697589;font-size:12px;word-break:break-word}
.login-wrapper{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{width:100%;max-width:420px;background:#fff;border:1px solid #e1e6ee;border-radius:16px;box-shadow:0 10px 35px rgba(20,30,50,.08);padding:34px;text-align:center}
.login-logo{font-size:42px;margin-bottom:12px}
.login-card h1{margin:0 0 8px;font-size:24px}
.login-card p{color:#687386;margin-bottom:24px}
.login-card input[type=password]{width:100%;padding:13px;border:1px solid #dce2eb;border-radius:8px;font-size:15px;outline:none;margin-bottom:12px}
.login-btn{width:100%;border:0;background:#1877f2;color:#fff;padding:13px;border-radius:8px;font-weight:800;font-size:15px;cursor:pointer}
.login-error{background:#fff0f0;border:1px solid #ffd1d1;color:#c62828;padding:10px;border-radius:8px;margin-bottom:14px;font-size:13px}
@media(max-width:700px){.topbar{flex-direction:column;align-items:stretch}.top-actions{width:100%;flex-direction:column}.connect-btn,.logout-form,.logout-btn{width:100%}.account-header{flex-direction:column;align-items:stretch}.account-actions{width:100%}.account-actions form{flex:1}.account-actions button{width:100%}.list-toolbar{flex-direction:column;align-items:stretch}.select-actions{width:100%}.small-btn{flex:1}.publisher-header{flex-direction:column;align-items:stretch}.result-row{grid-template-columns:1fr}}`;

  return new Response(
    "<!DOCTYPE html>" +
    '<html lang="en">' +
      "<head>" +
        '<meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
        "<title>" +
          escapeHtml(title) +
          " - " +
          escapeHtml(APP_NAME) +
        "</title>" +
        "<style>" +
          css +
        "</style>" +
      "</head>" +

      "<body>" +
        content +
      "</body>" +

    "</html>",
    {
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
        "Cache-Control":
          "no-store"
      }
    }
  );
}

function escapeHtml(value) {
  return String(
    value == null ? "" : value
  )
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
