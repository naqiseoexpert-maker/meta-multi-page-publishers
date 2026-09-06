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
        return Response.redirect(url.origin + "/login", 302);
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

      return new Response("Not Found", {
        status: 404
      });
    } catch (error) {
      console.error(error);

      return page(
        "Error",
        '<div class="error-page">' +
          '<div class="error-box">' +
            '<div class="error-icon">!</div>' +
            "<h2>Something went wrong</h2>" +
            "<p>The application encountered an unexpected error.</p>" +
            "<pre>" +
              escapeHtml(
                error && (error.stack || error.message)
                  ? error.stack || error.message
                  : String(error)
              ) +
            "</pre>" +
            '<a class="back-btn" href="/">Back to Dashboard</a>' +
          "</div>" +
        "</div>"
      );
    }
  }
};


/* =========================================================
   AUTHENTICATION
   ========================================================= */

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
      '<span class="login-error-icon">!</span>' +
      "<span>" +
        escapeHtml(errorMessage) +
      "</span>" +
      "</div>"
    : "";

  return page(
    "Login",

    '<div class="login-wrapper">' +

      '<div class="login-background-shape shape-one"></div>' +
      '<div class="login-background-shape shape-two"></div>' +

      '<div class="login-card">' +

        '<div class="login-brand">' +
          '<div class="login-logo">' +
            '<span class="logo-symbol">M</span>' +
          "</div>" +

          '<div class="login-brand-text">' +
            "<strong>Meta Publisher</strong>" +
            "<span>Multi Page Management</span>" +
          "</div>" +
        "</div>" +

        '<div class="login-content">' +

          "<h1>Welcome back</h1>" +

          "<p>" +
            "Sign in to manage and publish content across your Facebook Pages." +
          "</p>" +

          errorHtml +

          '<form method="POST" action="/login" class="login-form">' +

            '<label for="password">Password</label>' +

            '<div class="password-field">' +
              '<span class="field-icon">●</span>' +
              '<input id="password" type="password" name="password" placeholder="Enter your password" autocomplete="current-password" required autofocus />' +
            "</div>" +

            '<button type="submit" class="login-btn">' +
              "<span>Sign In</span>" +
              '<span class="login-arrow">→</span>' +
            "</button>" +

          "</form>" +

          '<div class="login-footer">' +
            '<span class="secure-dot"></span>' +
            "Private & secure dashboard" +
          "</div>" +

        "</div>" +

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

  if (!password || password !== configuredPassword) {
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
        "; Path=/; HttpOnly; Secure; SameSite=Lax",
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


/* =========================================================
   DATABASE
   ========================================================= */

async function ensureDatabaseSchema(db) {
  if (!db) {
    throw new Error(
      "D1 database binding DB is missing. Check your Cloudflare Worker D1 binding name."
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
    "CREATE INDEX IF NOT EXISTS idx_pages_account_id ON pages(account_id)"
  ).run();
}


/* =========================================================
   META CONFIG
   ========================================================= */

function getMetaConfig(env) {
  const appId = String(
    env.META_APP_ID || ""
  ).trim();

  const appSecret = String(
    env.META_APP_SECRET || ""
  ).trim();

  let graphVersion = String(
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
    graphVersion = "v24.0";
  }

  if (missing.length > 0) {
    throw new Error(
      "Meta configuration is missing: " +
      missing.join(", ") +
      ". Make sure these exact names exist in Cloudflare Worker > Settings > Variables and Secrets: META_APP_ID and META_APP_SECRET."
    );
  }

  if (!graphVersion.startsWith("v")) {
    graphVersion = "v" + graphVersion;
  }

  return {
    appId: appId,
    appSecret: appSecret,
    graphVersion: graphVersion
  };
}


/* =========================================================
   DASHBOARD
   ========================================================= */

async function showDashboard(env) {
  const accountsResult = await env.DB.prepare(
    "SELECT id, facebook_user_id, account_name, created_at " +
    "FROM accounts ORDER BY id ASC"
  ).all();

  const accounts = accountsResult.results || [];

  const pagesResult = await env.DB.prepare(
    "SELECT id, facebook_page_id, page_name, account_id " +
    "FROM pages " +
    "ORDER BY account_id ASC, page_name COLLATE NOCASE ASC"
  ).all();

  const pages = pagesResult.results || [];

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

  const totalAccounts = accounts.length;
  const totalPages = pages.length;

  let accountHtml = "";

  if (accounts.length === 0) {
    accountHtml =
      '<div class="empty-state">' +

        '<div class="empty-icon">' +
          "f" +
        "</div>" +

        "<h3>No Facebook account connected</h3>" +

        "<p>" +
          "Connect your Facebook account to start managing and publishing to your Pages." +
        "</p>" +

        '<a class="empty-connect-btn" href="/auth/meta">' +
          '<span>+</span>' +
          " Connect Facebook Account" +
        "</a>" +

      "</div>";
  } else {
    for (const account of accounts) {
      const accountPages =
        groupedPages[account.id] || [];

      let pageHtml = "";

      if (accountPages.length > 0) {
        pageHtml =
          '<div class="pages-toolbar">' +

            '<div class="pages-toolbar-title">' +
              '<span class="toolbar-check">✓</span>' +
              "<div>" +
                "<strong>Select Pages</strong>" +
                "<small>Choose where you want to publish</small>" +
              "</div>" +
            "</div>" +

            '<div class="select-actions">' +

              '<button type="button" class="small-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',true)">' +
                "Select All" +
              "</button>" +

              '<button type="button" class="small-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',false)">' +
                "Clear" +
              "</button>" +

            "</div>" +

          "</div>" +

          '<div class="page-list">';

        for (const p of accountPages) {
          const pageInitial =
            String(
              p.page_name || "P"
            )
              .trim()
              .charAt(0)
              .toUpperCase() || "P";

          pageHtml +=
            '<label class="page-row">' +

              '<input class="page-checkbox account-' +
                Number(account.id) +
                '" type="checkbox" name="page_ids" value="' +
                escapeHtml(p.id) +
                '" form="publish-form" />' +

              '<span class="custom-checkbox"></span>' +

              '<div class="page-avatar">' +
                escapeHtml(pageInitial) +
              "</div>" +

              '<div class="page-info">' +

                '<div class="page-name">' +
                  escapeHtml(
                    p.page_name || "Unnamed Page"
                  ) +
                "</div>" +

                '<div class="page-id">' +
                  "Page ID: " +
                  escapeHtml(p.facebook_page_id) +
                "</div>" +

              "</div>" +

              '<span class="page-arrow">›</span>' +

            "</label>";
        }

        pageHtml += "</div>";
      } else {
        pageHtml =
          '<div class="no-pages">' +

            '<div class="no-pages-icon">↻</div>' +

            "<div>" +
              "<strong>No Pages found</strong>" +
              "<p>Click Sync Pages to refresh your Facebook Pages.</p>" +
            "</div>" +

          "</div>";
      }

      const accountInitial =
        String(
          account.account_name || "F"
        )
          .trim()
          .charAt(0)
          .toUpperCase() || "F";

      accountHtml +=
        '<section class="account-card">' +

          '<div class="account-header">' +

            '<div class="account-main">' +

              '<div class="account-avatar">' +
                escapeHtml(accountInitial) +
              "</div>" +

              '<div class="account-details">' +

                '<div class="account-title-row">' +

                  "<h2>" +
                    escapeHtml(
                      account.account_name ||
                      "Facebook Account"
                    ) +
                  "</h2>" +

                  '<span class="connected-badge">' +
                    '<span class="status-dot"></span>' +
                    "Connected" +
                  "</span>" +

                "</div>" +

                '<div class="facebook-id">' +
                  '<span class="fb-mini">f</span>' +
                  " Facebook ID: " +
                  "<code>" +
                  escapeHtml(
                    account.facebook_user_id
                  ) +
                  "</code>" +
                "</div>" +

              "</div>" +

            "</div>" +

            '<div class="account-right">' +

              '<div class="account-page-stat">' +
                '<strong>' +
                  accountPages.length +
                "</strong>" +
                "<span>" +
                  (
                    accountPages.length === 1
                      ? "Page"
                      : "Pages"
                  ) +
                "</span>" +
              "</div>" +

              '<div class="account-actions">' +

                '<form method="POST" action="/sync" onsubmit="showButtonLoading(this, \'Syncing...\')">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(account.id) +
                  '" />' +

                  '<button class="btn btn-blue" type="submit">' +
                    '<span class="btn-icon">↻</span>' +
                    "Sync Pages" +
                  "</button>" +

                "</form>" +

                '<form method="POST" action="/remove-account" ' +
                  'onsubmit="return confirm(\'Remove this Facebook account and all its connected Pages?\');">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(account.id) +
                  '" />' +

                  '<button class="btn btn-delete" type="submit">' +
                    "Remove" +
                  "</button>" +

                "</form>" +

              "</div>" +

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

        '<div class="publisher-heading">' +

          '<div class="publisher-title-wrap">' +

            '<div class="publisher-icon">' +
              "✎" +
            "</div>" +

            "<div>" +
              "<h2>Create & Publish</h2>" +
              "<p>Create a post and publish it to your selected Pages.</p>" +
            "</div>" +

          "</div>" +

          '<div id="selected-count" class="selected-badge">' +
            "0 Pages Selected" +
          "</div>" +

        "</div>" +

        '<div class="publisher-divider"></div>' +

        '<form id="publish-form" method="POST" action="/publish" enctype="multipart/form-data">' +

          '<div class="field">' +

            '<label for="message">' +
              "Post Text" +
              '<span class="optional-label">Optional</span>' +
            "</label>" +

            '<textarea id="message" name="message" rows="7" maxlength="63206" placeholder="What would you like to share with your audience?"></textarea>' +

            '<div class="field-bottom">' +
              '<span>Write your message, announcement or update.</span>' +
              '<span id="char-count">0 characters</span>' +
            "</div>" +

          "</div>" +

          '<div class="field">' +

            '<label for="media">' +
              "Media" +
              '<span class="optional-label">Optional</span>' +
            "</label>" +

            '<label class="file-drop" for="media">' +

              '<div class="file-icon">↑</div>' +

              '<div class="file-text">' +
                "<strong>Choose an image or video</strong>" +
                "<span>PNG, JPG, GIF, MP4 and other supported formats</span>" +
              "</div>" +

              '<span class="browse-btn">Browse</span>' +

            "</label>" +

            '<input id="media" class="hidden-file" type="file" name="media" accept="image/*,video/*" />' +

            '<div id="file-name" class="selected-file"></div>' +

            '<div class="hint">' +
              "Leave empty for a text-only post. Maximum supported file size is 100 MB." +
            "</div>" +

          "</div>" +

          '<div class="publish-footer">' +

            '<div class="publish-info">' +
              '<span class="publish-info-icon">✓</span>' +
              '<span>Posts will be published to every selected Page.</span>' +
            "</div>" +

            '<button id="publish-btn" class="publish-btn" type="submit">' +
              '<span class="publish-btn-icon">↑</span>' +
              "<span>Publish to Selected Pages</span>" +
            "</button>" +

          "</div>" +

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

          "if(checked.length>0){" +
            "counter.classList.add('active');" +
          "}else{" +
            "counter.classList.remove('active');" +
          "}" +

        "}" +

        "document.querySelectorAll('.page-row').forEach(function(row){" +

          "const checkbox=row.querySelector('.page-checkbox');" +

          "if(checkbox&&checkbox.checked){" +
            "row.classList.add('selected');" +
          "}else{" +
            "row.classList.remove('selected');" +
          "}" +

        "});" +

      "}" +

      "function selectAccountPages(accountId,select){" +

        "document.querySelectorAll('.account-'+accountId).forEach(function(c){c.checked=select;});" +

        "updateSelectedCount();" +

      "}" +

      "function showButtonLoading(form,text){" +

        "const button=form.querySelector('button[type=submit]');" +

        "if(button){" +
          "button.disabled=true;" +
          "button.innerHTML='<span class=\"spinner\"></span>'+text;" +
        "}" +

      "}" +

      "document.addEventListener('change',function(e){" +

        "if(e.target&&e.target.classList.contains('page-checkbox')){" +
          "updateSelectedCount();" +
        "}" +

        "if(e.target&&e.target.id==='media'){" +

          "const fileName=document.getElementById('file-name');" +

          "if(e.target.files&&e.target.files.length){" +
            "fileName.textContent='Selected: '+e.target.files[0].name;" +
            "fileName.classList.add('visible');" +
          "}else{" +
            "fileName.textContent='';" +
            "fileName.classList.remove('visible');" +
          "}" +

        "}" +

      "});" +

      "document.addEventListener('click',function(e){" +

        "const row=e.target.closest('.page-row');" +

        "if(row&&e.target.tagName!=='INPUT'){" +

          "const checkbox=row.querySelector('.page-checkbox');" +

          "if(checkbox){" +
            "checkbox.checked=!checkbox.checked;" +
            "updateSelectedCount();" +
          "}" +

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

        "const button=document.getElementById('publish-btn');" +

        "if(button){" +
          "button.disabled=true;" +
          "button.innerHTML='<span class=\"spinner\"></span><span>Publishing...</span>';" +
        "}" +

        "return true;" +

      "}" +

      "const messageBox=document.getElementById('message');" +

      "const charCount=document.getElementById('char-count');" +

      "if(messageBox&&charCount){" +

        "messageBox.addEventListener('input',function(){" +
          "charCount.textContent=this.value.length.toLocaleString()+' characters';" +
        "});" +

      "}" +

      "updateSelectedCount();" +

    "</script>";

  return page(
    APP_NAME,

    '<div class="app-shell">' +

      '<header class="topbar">' +

        '<div class="topbar-inner">' +

          '<div class="brand-area">' +

            '<div class="brand-logo">' +
              '<span>M</span>' +
            "</div>" +

            '<div class="brand-copy">' +
              '<div class="brand">' +
                escapeHtml(APP_NAME) +
              "</div>" +
              '<div class="subtitle">' +
                "Multi-page publishing dashboard" +
              "</div>" +
            "</div>" +

          "</div>" +

          '<div class="top-actions">' +

            '<a class="connect-btn" href="/auth/meta">' +
              '<span class="connect-plus">+</span>' +
              "Connect Facebook" +
            "</a>" +

            '<form method="POST" action="/logout" class="logout-form">' +

              '<button class="logout-btn" type="submit">' +
                '<span class="logout-icon">↪</span>' +
                "Logout" +
              "</button>" +

            "</form>" +

          "</div>" +

        "</div>" +

      "</header>" +

      '<main class="main-content">' +

        '<div class="container">' +

          '<div class="welcome-section">' +

            '<div>' +
              '<div class="eyebrow">DASHBOARD</div>' +
              "<h1>Manage your Facebook Pages</h1>" +
              "<p>Connect accounts, select Pages and publish content from one place.</p>" +
            "</div>" +

            '<div class="dashboard-stats">' +

              '<div class="stat-card">' +
                '<div class="stat-icon account-stat-icon">◎</div>' +
                '<div>' +
                  '<strong>' +
                    totalAccounts +
                  "</strong>" +
                  "<span>" +
                    (
                      totalAccounts === 1
                        ? "Account"
                        : "Accounts"
                    ) +
                  "</span>" +
                "</div>" +
              "</div>" +

              '<div class="stat-card">' +
                '<div class="stat-icon page-stat-icon">▦</div>' +
                '<div>' +
                  '<strong>' +
                    totalPages +
                  "</strong>" +
                  "<span>" +
                    (
                      totalPages === 1
                        ? "Page"
                        : "Pages"
                    ) +
                  "</span>" +
                "</div>" +
              "</div>" +

            "</div>" +

          "</div>" +

          '<div class="section-heading">' +

            '<div>' +
              "<h2>Connected Accounts</h2>" +
              "<p>Manage your connected Facebook accounts and Pages.</p>" +
            "</div>" +

            '<span class="account-count">' +
              totalAccounts +
              (
                totalAccounts === 1
                  ? " account"
                  : " accounts"
              ) +
            "</span>" +

          "</div>" +

          accountHtml +

          publisherHtml +

        "</div>" +

      "</main>" +

      '<footer class="app-footer">' +
        '<div>' +
          "Meta Multi Page Publisher" +
          '<span class="footer-dot">•</span>' +
          "Secure dashboard" +
        "</div>" +
      "</footer>" +

    "</div>" +

    script
  );
}


/* =========================================================
   META LOGIN
   ========================================================= */

function startMetaLogin(request, env) {
  const config = getMetaConfig(env);

  const requestUrl = new URL(request.url);

  const redirectUri =
    requestUrl.origin +
    "/auth/meta/callback";

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const state =
    crypto.randomUUID();

  const loginUrl =
    "https://www.facebook.com/" +
    config.graphVersion +
    "/dialog/oauth" +

    "?client_id=" +
    encodeURIComponent(config.appId) +

    "&redirect_uri=" +
    encodeURIComponent(redirectUri) +

    "&scope=" +
    encodeURIComponent(scope) +

    "&state=" +
    encodeURIComponent(state) +

    "&auth_type=reauthorize";

  return Response.redirect(
    loginUrl,
    302
  );
}


/* =========================================================
   META CALLBACK
   ========================================================= */

async function metaCallback(request, env) {
  const config = getMetaConfig(env);

  const url = new URL(request.url);

  const code =
    url.searchParams.get("code");

  const error =
    url.searchParams.get("error");

  const errorDescription =
    url.searchParams.get("error_description");

  if (error) {
    return page(
      "Facebook Login Error",

      '<div class="error-page">' +

        '<div class="error-box">' +

          '<div class="error-icon">!</div>' +

          "<h2>Facebook Login Error</h2>" +

          "<p>" +
            escapeHtml(error) +
          "</p>" +

          (
            errorDescription
              ? "<p>" +
                escapeHtml(
                  errorDescription
                ) +
                "</p>"
              : ""
          ) +

          '<a class="back-btn" href="/">' +
            "Back to Dashboard" +
          "</a>" +

        "</div>" +

      "</div>"
    );
  }

  if (!code) {
    throw new Error(
      "No authorization code received from Facebook."
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
      formatGraphError(tokenData)
    );
  }

  const userAccessToken =
    tokenData.access_token;

  const userUrl =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/me?fields=id,name&access_token=" +
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
      formatGraphError(userData)
    );
  }

  await env.DB.prepare(
    "INSERT INTO accounts " +
    "(facebook_user_id, account_name, access_token) " +
    "VALUES (?, ?, ?) " +

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
    .bind(
      String(userData.id)
    )
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


/* =========================================================
   SYNC PAGES
   ========================================================= */

async function syncPages(request, env) {
  const form =
    await request.formData();

  const accountId =
    Number(
      form.get("account_id")
    );

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
    Number(account.id),
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

    if (
      !response.ok ||
      data.error
    ) {
      throw new Error(
        "Could not load Facebook Pages: " +
        formatGraphError(data)
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
        "INSERT INTO pages " +
        "(facebook_page_id, page_name, access_token, account_id) " +
        "VALUES (?, ?, ?, ?) " +

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
    .bind(
      Number(accountId)
    )
    .run();
  }
}


/* =========================================================
   REMOVE ACCOUNT
   ========================================================= */

async function removeAccount(
  request,
  env
) {
  const form =
    await request.formData();

  const accountId =
    Number(
      form.get("account_id")
    );

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  await env.DB.prepare(
    "DELETE FROM pages " +
    "WHERE account_id = ?"
  )
  .bind(accountId)
  .run();

  await env.DB.prepare(
    "DELETE FROM accounts " +
    "WHERE id = ?"
  )
  .bind(accountId)
  .run();

  return Response.redirect(
    "/",
    303
  );
}


/* =========================================================
   PUBLISH
   ========================================================= */

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
    throw new Error(
      "Please select at least one Facebook Page."
    );
  }

  if (
    !message &&
    (!media || !media.name)
  ) {
    throw new Error(
      "Please enter post text or select an image/video."
    );
  }

  const numericPageIds =
    selectedPageIds
      .map(Number)
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
      "FROM pages WHERE id IN (" +
      placeholders +
      ") " +
      "ORDER BY page_name COLLATE NOCASE ASC"
    )
    .bind(
      ...numericPageIds
    )
    .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    throw new Error(
      "Selected Pages were not found."
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
    mediaName =
      media.name;

    if (
      (media.type || "")
        .startsWith("image/")
    ) {
      mediaType = "image";

    } else if (
      (media.type || "")
        .startsWith("video/")
    ) {
      mediaType = "video";

    } else {
      throw new Error(
        "Unsupported media type."
      );
    }

    mediaBuffer =
      await media.arrayBuffer();

    if (
      mediaBuffer.byteLength >
      100 * 1024 * 1024
    ) {
      throw new Error(
        "File is too large. Maximum supported size is 100 MB."
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
        pageId: fbPage.facebook_page_id,
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
          error.message ||
          String(error)
      });
    }
  }

  const successCount =
    results.filter(function (r) {
      return r.success;
    }).length;

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

        '<div class="result-left">' +

          '<div class="result-page-avatar">' +
            escapeHtml(
              String(
                r.page || "P"
              )
                .trim()
                .charAt(0)
                .toUpperCase() || "P"
            ) +
          "</div>" +

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

        "</div>" +

        '<div class="result-status">' +
          (
            r.success
              ? '<span class="success-icon">✓</span> Published'
              : '<span class="failed-icon">×</span> Failed'
          ) +
        "</div>" +

        (
          r.success

            ? (
                r.postId
                  ? '<div class="result-extra">' +
                    "Post ID: " +
                    escapeHtml(
                      r.postId
                    ) +
                    "</div>"
                  : ""
              )

            : '<div class="result-extra result-error-text">' +
              escapeHtml(
                r.error || ""
              ) +
              "</div>"
        ) +

      "</div>";
  }

  return page(
    "Publish Results",

    '<div class="results-page">' +

      '<div class="results-header">' +

        '<a class="results-back-link" href="/">' +
          "← Dashboard" +
        "</a>" +

        '<div class="results-title">' +
          '<div class="publisher-icon">' +
            "✓" +
          "</div>" +

          "<div>" +
            "<h1>Publish Results</h1>" +
            "<p>Your publishing activity has been completed.</p>" +
          "</div>" +
        "</div>" +

      "</div>" +

      '<div class="results-card">' +

        '<div class="result-summary-card">' +

          '<div class="summary-big">' +
            successCount +
          "</div>" +

          '<div class="summary-text">' +
            "<strong>Successfully Published</strong>" +
            "<span>out of " +
              results.length +
              (
                results.length === 1
                  ? " selected Page"
                  : " selected Pages"
              ) +
            "</span>" +
          "</div>" +

        "</div>" +

        '<div class="results-list">' +
          resultsHtml +
        "</div>" +

        '<a class="back-btn" href="/">' +
          "Back to Dashboard" +
        "</a>" +

      "</div>" +

    "</div>"
  );
}


/* =========================================================
   FACEBOOK POSTS
   ========================================================= */

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


/* =========================================================
   GRAPH API
   ========================================================= */

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
  } catch {
    return {
      error: {
        message:
          text ||
          "Facebook returned HTTP " +
          response.status,

        type:
          "NonJSONResponse",

        code:
          response.status
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


/* =========================================================
   HTML PAGE + PROFESSIONAL CSS
   ========================================================= */

function page(
  title,
  content
) {
  const css = [

    "*{box-sizing:border-box}",

    ":root{--primary:#1877f2;--primary-dark:#0d65d9;--navy:#101828;--text:#172033;--muted:#667085;--border:#e4e7ec;--bg:#f6f8fc;--white:#fff}",

    "html{scroll-behavior:smooth}",

    "body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}",

    "button,input,textarea{font-family:inherit}",

    "button:disabled{opacity:.7;cursor:not-allowed}",

    "a{transition:all .2s ease}",


    /* APP */

    ".app-shell{min-height:100vh;display:flex;flex-direction:column}",

    ".main-content{flex:1}",

    ".topbar{background:rgba(255,255,255,.96);border-bottom:1px solid #e6eaf0;position:sticky;top:0;z-index:50;backdrop-filter:blur(14px)}",

    ".topbar-inner{max-width:1280px;margin:0 auto;padding:16px 28px;display:flex;align-items:center;justify-content:space-between;gap:25px}",

    ".brand-area{display:flex;align-items:center;gap:12px;min-width:0}",

    ".brand-logo{width:43px;height:43px;border-radius:12px;background:linear-gradient(135deg,#1877f2,#0756c9);display:flex;align-items:center;justify-content:center;box-shadow:0 5px 15px rgba(24,119,242,.22);flex:0 0 auto}",

    ".brand-logo span{color:#fff;font-weight:900;font-size:22px}",

    ".brand-copy{min-width:0}",

    ".brand{font-size:16px;font-weight:800;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".subtitle{font-size:12px;color:#8a94a6;margin-top:2px}",

    ".top-actions{display:flex;align-items:center;gap:9px}",

    ".connect-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:#1877f2;color:#fff;text-decoration:none;padding:11px 16px;border-radius:9px;font-size:13px;font-weight:750;box-shadow:0 3px 8px rgba(24,119,242,.18)}",

    ".connect-btn:hover{background:#0d65d9;transform:translateY(-1px);box-shadow:0 5px 13px rgba(24,119,242,.25)}",

    ".connect-plus{font-size:19px;line-height:12px;font-weight:400}",

    ".logout-form{margin:0}",

    ".logout-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #e1e5eb;background:#fff;color:#475467;border-radius:9px;padding:10px 13px;font-weight:700;font-size:13px;cursor:pointer}",

    ".logout-btn:hover{background:#f8fafc;border-color:#cfd5dd}",

    ".logout-icon{font-size:16px}",


    /* MAIN */

    ".container{max-width:1280px;margin:0 auto;padding:35px 28px 65px}",

    ".welcome-section{display:flex;align-items:flex-end;justify-content:space-between;gap:25px;margin-bottom:34px}",

    ".eyebrow{font-size:11px;letter-spacing:1.5px;font-weight:800;color:#1877f2;margin-bottom:8px}",

    ".welcome-section h1{font-size:30px;line-height:1.2;letter-spacing:-.8px;margin:0 0 7px;font-weight:800;color:#101828}",

    ".welcome-section p{font-size:14px;color:#667085;margin:0;line-height:1.6}",

    ".dashboard-stats{display:flex;gap:12px}",

    ".stat-card{min-width:150px;background:#fff;border:1px solid #e4e7ec;border-radius:13px;padding:13px 15px;display:flex;align-items:center;gap:11px;box-shadow:0 3px 12px rgba(16,24,40,.035)}",

    ".stat-icon{width:39px;height:39px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700}",

    ".account-stat-icon{background:#eef5ff;color:#1877f2}",

    ".page-stat-icon{background:#f0fdf4;color:#16a34a}",

    ".stat-card strong{display:block;font-size:20px;line-height:1.1;color:#101828}",

    ".stat-card span{display:block;color:#667085;font-size:11px;margin-top:3px}",


    /* SECTION */

    ".section-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:15px}",

    ".section-heading h2{margin:0;font-size:18px;letter-spacing:-.25px}",

    ".section-heading p{margin:4px 0 0;font-size:12px;color:#7a8494}",

    ".account-count{font-size:12px;color:#667085;background:#fff;border:1px solid #e4e7ec;padding:7px 11px;border-radius:20px;font-weight:700}",


    /* ACCOUNT */

    ".account-card{background:#fff;border:1px solid #e1e6ee;border-radius:16px;box-shadow:0 4px 18px rgba(16,24,40,.045);margin-bottom:18px;overflow:hidden;transition:box-shadow .2s ease,border-color .2s ease}",

    ".account-card:hover{border-color:#d5dce6;box-shadow:0 7px 24px rgba(16,24,40,.07)}",

    ".account-header{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:25px}",

    ".account-main{display:flex;align-items:center;gap:13px;min-width:0}",

    ".account-avatar{width:46px;height:46px;flex:0 0 auto;border-radius:12px;background:linear-gradient(135deg,#1877f2,#0756c9);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;box-shadow:0 5px 13px rgba(24,119,242,.18)}",

    ".account-details{min-width:0}",

    ".account-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",

    ".account-header h2{margin:0;font-size:16px;font-weight:800;color:#172033}",

    ".connected-badge{display:inline-flex;align-items:center;gap:5px;background:#ecfdf3;color:#15803d;border:1px solid #d1fadf;padding:4px 7px;border-radius:20px;font-size:10px;font-weight:800}",

    ".status-dot{width:6px;height:6px;background:#22c55e;border-radius:50%;display:inline-block}",

    ".facebook-id{margin-top:5px;color:#8993a3;font-size:11px;display:flex;align-items:center;gap:5px}",

    ".fb-mini{width:16px;height:16px;border-radius:4px;background:#1877f2;color:#fff;font-size:11px;font-weight:900;display:inline-flex;align-items:center;justify-content:center}",

    "code{background:#f2f4f7;padding:2px 5px;border-radius:4px;font-size:10px;color:#475467;word-break:break-all}",

    ".account-right{display:flex;align-items:center;gap:20px}",

    ".account-page-stat{text-align:right;min-width:50px}",

    ".account-page-stat strong{display:block;font-size:18px;line-height:1;color:#172033}",

    ".account-page-stat span{display:block;color:#8993a3;font-size:10px;margin-top:4px}",

    ".account-actions{display:flex;gap:7px;align-items:center}",

    ".account-actions form{margin:0}",

    ".btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;padding:9px 12px;cursor:pointer;font-weight:750;font-size:11px;white-space:nowrap;transition:all .18s ease}",

    ".btn-blue{background:#1877f2;color:#fff;box-shadow:0 2px 6px rgba(24,119,242,.14)}",

    ".btn-blue:hover{background:#0d65d9;transform:translateY(-1px)}",

    ".btn-delete{background:#fff;color:#d92d20;border:1px solid #f0d1cf}",

    ".btn-delete:hover{background:#fff5f4;border-color:#efb5b1}",

    ".btn-icon{font-size:15px}",


    /* PAGES */

    ".pages-section{padding:0 22px 22px}",

    ".pages-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:13px 14px;margin-bottom:10px;background:#f8fafc;border:1px solid #edf0f4;border-radius:10px}",

    ".pages-toolbar-title{display:flex;align-items:center;gap:9px}",

    ".toolbar-check{width:25px;height:25px;border-radius:7px;background:#eaf2ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900}",

    ".pages-toolbar-title strong{display:block;font-size:12px;color:#344054}",

    ".pages-toolbar-title small{display:block;font-size:10px;color:#98a2b3;margin-top:2px}",

    ".select-actions{display:flex;gap:6px}",

    ".small-btn{background:#fff;color:#475467;border:1px solid #dfe4eb;border-radius:7px;padding:7px 10px;cursor:pointer;font-size:10px;font-weight:750;transition:.18s}",

    ".small-btn:hover{border-color:#b7c0cc;background:#f8fafc}",

    ".page-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}",

    ".page-row{position:relative;display:flex;align-items:center;gap:10px;min-height:59px;padding:10px 12px;background:#fff;border:1px solid #e7eaf0;border-radius:9px;cursor:pointer;transition:all .18s ease}",

    ".page-row:hover{background:#f9fbff;border-color:#bcd5f7;transform:translateY(-1px)}",

    ".page-row.selected{background:#f5f9ff;border-color:#9fc5f4}",

    ".page-checkbox{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",

    ".custom-checkbox{width:17px;height:17px;flex:0 0 auto;border:1.5px solid #c9d0da;border-radius:5px;background:#fff;position:relative;transition:.18s}",

    ".page-row.selected .custom-checkbox{background:#1877f2;border-color:#1877f2}",

    ".page-row.selected .custom-checkbox:after{content:'✓';position:absolute;left:2px;top:-1px;color:#fff;font-size:12px;font-weight:900}",

    ".page-avatar{width:34px;height:34px;flex:0 0 auto;border-radius:9px;background:#eef4ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800}",

    ".page-info{min-width:0;flex:1}",

    ".page-name{font-size:12px;font-weight:750;margin-bottom:3px;color:#1d2939;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".page-id{font-size:9px;color:#98a2b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".page-arrow{font-size:18px;color:#c2c8d1;margin-left:3px}",

    ".no-pages{padding:22px;background:#f8fafc;border:1px dashed #d9dee7;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:12px;text-align:left}",

    ".no-pages-icon{width:34px;height:34px;border-radius:9px;background:#fff;color:#667085;border:1px solid #e4e7ec;display:flex;align-items:center;justify-content:center;font-size:18px}",

    ".no-pages strong{font-size:12px;color:#344054}",

    ".no-pages p{margin:3px 0 0;font-size:10px;color:#98a2b3}",


    /* EMPTY */

    ".empty-state{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:55px 25px;text-align:center;box-shadow:0 4px 18px rgba(16,24,40,.035);margin-bottom:25px}",

    ".empty-icon{width:58px;height:58px;border-radius:16px;background:#eef5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;margin:0 auto 17px}",

    ".empty-state h3{margin:0 0 7px;font-size:18px}",

    ".empty-state p{margin:0 auto 20px;max-width:460px;color:#667085;font-size:13px;line-height:1.6}",

    ".empty-connect-btn{display:inline-flex;align-items:center;gap:7px;background:#1877f2;color:#fff;text-decoration:none;border-radius:9px;padding:11px 16px;font-size:12px;font-weight:800}",

    ".empty-connect-btn:hover{background:#0d65d9}",

    ".empty-connect-btn span{font-size:18px}",


    /* PUBLISHER */

    ".publisher-card{background:#fff;border:1px solid #e1e6ee;border-radius:16px;box-shadow:0 4px 18px rgba(16,24,40,.045);padding:23px;margin-top:28px}",

    ".publisher-heading{display:flex;align-items:center;justify-content:space-between;gap:15px}",

    ".publisher-title-wrap{display:flex;align-items:center;gap:11px}",

    ".publisher-icon{width:40px;height:40px;border-radius:11px;background:#eef5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:800;flex:0 0 auto}",

    ".publisher-title-wrap h2{margin:0;font-size:17px;letter-spacing:-.2px}",

    ".publisher-title-wrap p{margin:3px 0 0;color:#8993a3;font-size:11px}",

    ".selected-badge{background:#f2f4f7;color:#667085;border:1px solid #e4e7ec;border-radius:20px;padding:7px 11px;font-size:10px;font-weight:800;white-space:nowrap}",

    ".selected-badge.active{background:#eef5ff;color:#1769d2;border-color:#d7e7fc}",

    ".publisher-divider{height:1px;background:#edf0f4;margin:20px 0}",

    ".field{margin-bottom:20px}",

    ".field label{display:flex;align-items:center;gap:7px;font-weight:750;font-size:12px;color:#344054;margin-bottom:8px}",

    ".optional-label{font-size:9px;font-weight:600;color:#98a2b3;background:#f2f4f7;padding:3px 6px;border-radius:10px}",

    "textarea{width:100%;resize:vertical;min-height:145px;border:1px solid #dfe3e9;border-radius:10px;padding:13px;font:inherit;font-size:13px;line-height:1.6;outline:none;color:#172033;background:#fff;transition:.18s}",

    "textarea::placeholder{color:#a2aab7}",

    "textarea:focus{border-color:#1877f2;box-shadow:0 0 0 3px rgba(24,119,242,.08)}",

    ".field-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px;color:#98a2b3;font-size:9px}",

    ".file-drop{display:flex!important;align-items:center;gap:11px;width:100%;padding:13px 14px;border:1px dashed #cdd4de;border-radius:10px;background:#fafbfc;cursor:pointer;transition:.18s}",

    ".file-drop:hover{background:#f5f9ff;border-color:#9fc5f4}",

    ".file-icon{width:34px;height:34px;border-radius:9px;background:#eef5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:800;flex:0 0 auto}",

    ".file-text{flex:1;min-width:0}",

    ".file-text strong{display:block;font-size:11px;color:#344054}",

    ".file-text span{display:block;font-size:9px;color:#98a2b3;margin-top:3px}",

    ".browse-btn{border:1px solid #d9dee7;background:#fff;color:#475467;border-radius:7px;padding:7px 10px;font-size:10px;font-weight:750}",

    ".hidden-file{display:none!important}",

    ".selected-file{display:none;margin-top:7px;padding:8px 10px;background:#eefaf3;border:1px solid #d2f2df;border-radius:7px;color:#16834b;font-size:10px;font-weight:700}",

    ".selected-file.visible{display:block}",

    ".hint{color:#98a2b3;font-size:9px;margin-top:7px}",

    ".publish-footer{border-top:1px solid #edf0f4;padding-top:17px;display:flex;align-items:center;justify-content:space-between;gap:15px}",

    ".publish-info{display:flex;align-items:center;gap:7px;color:#667085;font-size:10px}",

    ".publish-info-icon{width:19px;height:19px;background:#ecfdf3;color:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900}",

    ".publish-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;background:#1877f2;color:#fff;padding:12px 17px;border-radius:9px;font-size:11px;font-weight:800;cursor:pointer;box-shadow:0 3px 9px rgba(24,119,242,.18);transition:.18s}",

    ".publish-btn:hover{background:#0d65d9;transform:translateY(-1px);box-shadow:0 5px 14px rgba(24,119,242,.24)}",

    ".publish-btn-icon{font-size:15px}",


    /* LOADING */

    ".spinner{width:13px;height:13px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}",

    "@keyframes spin{to{transform:rotate(360deg)}}",


    /* RESULTS */

    ".results-page{max-width:950px;margin:0 auto;padding:35px 20px 70px}",

    ".results-header{margin-bottom:20px}",

    ".results-back-link{display:inline-block;color:#667085;text-decoration:none;font-size:12px;font-weight:700;margin-bottom:22px}",

    ".results-back-link:hover{color:#1877f2}",

    ".results-title{display:flex;align-items:center;gap:12px}",

    ".results-title h1{margin:0;font-size:25px;letter-spacing:-.5px}",

    ".results-title p{margin:4px 0 0;color:#8993a3;font-size:12px}",

    ".results-card{background:#fff;border:1px solid #e1e6ee;border-radius:16px;box-shadow:0 5px 22px rgba(16,24,40,.05);padding:22px}",

    ".result-summary-card{display:flex;align-items:center;gap:13px;padding:15px;background:#f8fafc;border:1px solid #edf0f4;border-radius:11px;margin-bottom:17px}",

    ".summary-big{width:48px;height:48px;border-radius:12px;background:#ecfdf3;color:#15803d;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:900}",

    ".summary-text strong{display:block;font-size:13px;color:#344054}",

    ".summary-text span{display:block;font-size:10px;color:#98a2b3;margin-top:3px}",

    ".results-list{display:flex;flex-direction:column;gap:8px}",

    ".result-row{border:1px solid #e4e7ec;border-radius:10px;padding:12px;display:grid;grid-template-columns:1fr auto;gap:8px 15px}",

    ".result-success{background:#f7fdf9;border-color:#d6f0df}",

    ".result-failed{background:#fff9f8;border-color:#f3d9d5}",

    ".result-left{display:flex;align-items:center;gap:9px;min-width:0}",

    ".result-page-avatar{width:33px;height:33px;border-radius:8px;background:#eef4ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex:0 0 auto}",

    ".result-row strong{font-size:12px;color:#344054}",

    ".result-page-id{margin-top:3px;color:#98a2b3;font-size:9px}",

    ".result-status{font-size:10px;font-weight:800;display:flex;align-items:center;white-space:nowrap}",

    ".result-success .result-status{color:#16834b}",

    ".result-failed .result-status{color:#d92d20}",

    ".success-icon,.failed-icon{width:17px;height:17px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-right:4px;font-size:10px}",

    ".success-icon{background:#dcfae6;color:#15803d}",

    ".failed-icon{background:#fee4e2;color:#d92d20}",

    ".result-extra{grid-column:1 / -1;color:#667085;font-size:9px;word-break:break-word;background:rgba(255,255,255,.65);padding:7px 8px;border-radius:6px}",

    ".result-error-text{color:#b42318}",

    ".back-btn{display:inline-flex;align-items:center;justify-content:center;margin-top:18px;padding:10px 14px;background:#1877f2;color:#fff;text-decoration:none;border-radius:8px;font-size:11px;font-weight:800}",

    ".back-btn:hover{background:#0d65d9}",


    /* ERROR */

    ".error-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px;background:#f6f8fc}",

    ".error-box{width:100%;max-width:850px;background:#fff;border:1px solid #e4e7ec;border-radius:16px;box-shadow:0 8px 30px rgba(16,24,40,.07);padding:30px}",

    ".error-icon{width:44px;height:44px;border-radius:12px;background:#fee4e2;color:#d92d20;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;margin-bottom:14px}",

    ".error-box h2{margin:0 0 7px;font-size:20px}",

    ".error-box p{color:#667085;font-size:13px;line-height:1.6}",

    "pre{background:#f8fafc;border:1px solid #edf0f4;padding:14px;border-radius:9px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#475467;font-size:11px;line-height:1.5}",


    /* LOGIN */

    ".login-wrapper{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:25px;background:linear-gradient(145deg,#f7faff,#eef4fc);overflow:hidden}",

    ".login-background-shape{position:absolute;border-radius:50%;filter:blur(2px);pointer-events:none}",

    ".shape-one{width:430px;height:430px;background:rgba(24,119,242,.055);top:-180px;right:-120px}",

    ".shape-two{width:350px;height:350px;background:rgba(24,119,242,.04);bottom:-170px;left:-130px}",

    ".login-card{position:relative;width:100%;max-width:430px;background:#fff;border:1px solid #e1e6ee;border-radius:19px;box-shadow:0 18px 55px rgba(16,24,40,.09);overflow:hidden}",

    ".login-brand{display:flex;align-items:center;gap:11px;padding:22px 25px;border-bottom:1px solid #edf0f4}",

    ".login-logo{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#1877f2,#0756c9);display:flex;align-items:center;justify-content:center;box-shadow:0 5px 13px rgba(24,119,242,.2)}",

    ".logo-symbol{color:#fff;font-size:20px;font-weight:900}",

    ".login-brand-text strong{display:block;font-size:13px;color:#172033}",

    ".login-brand-text span{display:block;color:#98a2b3;font-size:9px;margin-top:2px}",

    ".login-content{padding:29px 25px 24px}",

    ".login-content h1{margin:0 0 7px;font-size:25px;letter-spacing:-.5px;color:#101828}",

    ".login-content>p{margin:0 0 23px;color:#667085;font-size:12px;line-height:1.6}",

    ".login-form label{display:block;font-size:11px;font-weight:750;color:#344054;margin-bottom:7px}",

    ".password-field{position:relative}",

    ".password-field .field-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:7px;color:#98a2b3}",

    ".login-card input[type=password]{width:100%;padding:12px 12px 12px 28px;border:1px solid #dfe3e9;border-radius:9px;font-size:13px;outline:none;color:#172033;background:#fff;transition:.18s;margin:0 0 12px}",

    ".login-card input[type=password]:focus{border-color:#1877f2;box-shadow:0 0 0 3px rgba(24,119,242,.08)}",

    ".login-btn{width:100%;display:flex;align-items:center;justify-content:space-between;border:0;background:#1877f2;color:#fff;padding:12px 14px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer;transition:.18s}",

    ".login-btn:hover{background:#0d65d9;box-shadow:0 4px 12px rgba(24,119,242,.2)}",

    ".login-arrow{font-size:17px}",

    ".login-error{display:flex;align-items:center;gap:7px;background:#fff5f4;border:1px solid #f4d3d0;color:#b42318;padding:9px 10px;border-radius:8px;margin-bottom:13px;font-size:10px;line-height:1.4}",

    ".login-error-icon{width:17px;height:17px;border-radius:50%;background:#fee4e2;color:#d92d20;display:flex;align-items:center;justify-content:center;font-weight:900;flex:0 0 auto}",

    ".login-footer{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:20px;color:#98a2b3;font-size:9px}",

    ".secure-dot{width:6px;height:6px;border-radius:50%;background:#22c55e}",


    /* FOOTER */

    ".app-footer{text-align:center;padding:17px 20px;color:#98a2b3;font-size:9px;border-top:1px solid #e6eaf0;background:#fff}",

    ".footer-dot{margin:0 6px;color:#d0d5dd}",


    /* MOBILE */

    "@media(max-width:900px){.welcome-section{align-items:flex-start;flex-direction:column}.dashboard-stats{width:100%}.stat-card{flex:1}.account-header{align-items:flex-start;flex-direction:column}.account-right{width:100%;justify-content:space-between}.account-page-stat{text-align:left}.page-list{grid-template-columns:1fr}}",

    "@media(max-width:650px){.topbar-inner{padding:13px 15px;flex-direction:column;align-items:stretch;gap:12px}.brand-area{justify-content:center}.brand-copy{text-align:left}.top-actions{width:100%;display:grid;grid-template-columns:1fr 90px}.connect-btn,.logout-btn{width:100%;height:40px}.container{padding:25px 14px 45px}.welcome-section{margin-bottom:27px}.welcome-section h1{font-size:24px}.dashboard-stats{gap:8px}.stat-card{min-width:0;padding:11px}.stat-card strong{font-size:18px}.section-heading{align-items:flex-start}.account-count{display:none}.account-header{padding:16px}.account-main{width:100%}.account-right{gap:10px;flex-wrap:wrap}.account-actions{flex:1}.account-actions form{flex:1}.btn{width:100%;padding:9px 8px}.pages-section{padding:0 13px 15px}.pages-toolbar{align-items:flex-start;flex-direction:column}.select-actions{width:100%}.small-btn{flex:1}.publisher-card{padding:16px;margin-top:20px}.publisher-heading{align-items:flex-start;flex-direction:column}.selected-badge{align-self:flex-start}.publish-footer{align-items:stretch;flex-direction:column}.publish-btn{width:100%}.publish-info{align-items:flex-start}.results-page{padding:25px 12px 50px}.result-row{grid-template-columns:1fr}.result-status{justify-content:flex-start}.login-card{max-width:100%}}",

    "@media(max-width:400px){.brand{font-size:14px}.subtitle{font-size:10px}.dashboard-stats{flex-direction:column}.account-title-row{align-items:flex-start;flex-direction:column;gap:5px}.account-actions{width:100%}.file-drop{align-items:flex-start}.browse-btn{display:none}}"

  ].join("");

  return new Response(
    "<!DOCTYPE html>" +
    '<html lang="en">' +

      "<head>" +

        '<meta charset="UTF-8">' +

        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +

        '<meta name="theme-color" content="#1877f2">' +

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


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function escapeHtml(value) {
  return String(
    value == null
      ? ""
      : value
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
      "&#39;"
    );
}
