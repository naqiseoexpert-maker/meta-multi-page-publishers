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
        '<div class="error-page-wrap">' +
          '<div class="error-box">' +
            '<div class="error-icon">!</div>' +
            "<h2>Something went wrong</h2>" +
            "<p class=\"error-lead\">The dashboard encountered an unexpected error.</p>" +
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
    "Password Required",

    '<div class="login-screen">' +

      '<div class="login-decoration login-decoration-one"></div>' +
      '<div class="login-decoration login-decoration-two"></div>' +

      '<div class="login-card">' +

        '<div class="login-brand">' +
          '<div class="login-brand-icon">' +
            '<span>✦</span>' +
          "</div>" +

          "<div>" +
            '<div class="login-brand-name">Meta Publisher</div>' +
            '<div class="login-brand-sub">Multi Page Management</div>' +
          "</div>" +
        "</div>" +

        '<div class="login-title-area">' +
          '<div class="lock-circle">🔐</div>' +
          "<h1>Welcome Back</h1>" +
          "<p>Enter your password to access your publishing dashboard.</p>" +
        "</div>" +

        errorHtml +

        '<form method="POST" action="/login" class="login-form">' +

          '<div class="login-field">' +
            '<label for="login-password">Password</label>' +

            '<div class="password-wrap">' +
              '<span class="input-icon">●</span>' +
              '<input id="login-password" type="password" name="password" placeholder="Enter your password" autocomplete="current-password" required autofocus />' +
            "</div>" +
          "</div>" +

          '<button type="submit" class="login-btn">' +
            "<span>Access Dashboard</span>" +
            '<span class="login-arrow">→</span>' +
          "</button>" +

        "</form>" +

        '<div class="login-footer">' +
          '<span class="status-dot"></span>' +
          "Secure private dashboard" +
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

  let accountHtml = "";

  if (accounts.length === 0) {
    accountHtml =
      '<div class="empty-state">' +

        '<div class="empty-illustration">' +
          '<div class="empty-illustration-circle">f</div>' +
        "</div>" +

        "<h3>No Facebook account connected</h3>" +

        "<p>" +
          "Connect your Facebook account to start managing and publishing to your Pages." +
        "</p>" +

        '<a class="empty-connect-btn" href="/auth/meta">' +
          '<span>＋</span>' +
          "Connect Facebook Account" +
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

            '<div class="pages-toolbar-left">' +
              '<div class="pages-section-title">Connected Pages</div>' +
              '<div class="pages-section-subtitle">' +
                accountPages.length +
                " page" +
                (accountPages.length === 1 ? "" : "s") +
                " available for publishing" +
              "</div>" +
            "</div>" +

            '<div class="select-actions">' +

              '<button type="button" class="tool-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',true)">' +
                '<span>✓</span> Select All' +
              "</button>" +

              '<button type="button" class="tool-btn" onclick="selectAccountPages(' +
                Number(account.id) +
                ',false)">' +
                '<span>×</span> Clear' +
              "</button>" +

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
                '" form="publish-form" />' +

              '<div class="page-avatar">' +
                "f" +
              "</div>" +

              '<div class="page-info">' +

                '<div class="page-name">' +
                  escapeHtml(
                    p.page_name || "Unnamed Page"
                  ) +
                "</div>" +

                '<div class="page-meta">' +
                  '<span class="online-dot"></span>' +
                  "Connected" +
                  '<span class="meta-separator">•</span>' +
                  "Page ID " +
                  escapeHtml(p.facebook_page_id) +
                "</div>" +

              "</div>" +

              '<div class="page-select-indicator">' +
                '<span class="checkmark">✓</span>' +
              "</div>" +

            "</label>";
        }

        pageHtml += "</div>";
      } else {
        pageHtml =
          '<div class="no-pages">' +

            '<div class="no-pages-icon">◎</div>' +

            "<div>" +
              "<strong>No Pages found</strong>" +
              "<p>Click Sync Pages to refresh the Pages connected to this account.</p>" +
            "</div>" +

          "</div>";
      }

      accountHtml +=
        '<section class="account-card">' +

          '<div class="account-header">' +

            '<div class="account-main">' +

              '<div class="facebook-account-icon">f</div>' +

              '<div class="account-title-wrap">' +

                '<div class="account-label">' +
                  "FACEBOOK ACCOUNT" +
                "</div>" +

                "<h2>" +
                  escapeHtml(
                    account.account_name ||
                    "Facebook Account"
                  ) +
                "</h2>" +

                '<div class="facebook-id">' +
                  '<span>ID</span>' +
                  escapeHtml(
                    account.facebook_user_id
                  ) +
                "</div>" +

              "</div>" +

            "</div>" +

            '<div class="account-header-right">' +

              '<div class="account-page-count">' +
                '<strong>' +
                  accountPages.length +
                "</strong>" +
                "<span>" +
                  "Page" +
                  (accountPages.length === 1 ? "" : "s") +
                "</span>" +
              "</div>" +

              '<div class="account-actions">' +

                '<form method="POST" action="/sync">' +

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

                  '<button class="btn btn-light-danger" type="submit">' +
                    '<span class="btn-icon">⌫</span>' +
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

        '<div class="publisher-top">' +

          '<div class="publisher-title-area">' +

            '<div class="composer-icon">✎</div>' +

            "<div>" +
              '<div class="section-eyebrow">CONTENT PUBLISHER</div>' +
              "<h2>Create & Publish</h2>" +
              "<p>Write once and publish across all selected Facebook Pages.</p>" +
            "</div>" +

          "</div>" +

          '<div class="selection-badge" id="selected-count">' +
            '<span class="selection-dot"></span>' +
            "0 Pages Selected" +
          "</div>" +

        "</div>" +

        '<div class="publisher-divider"></div>' +

        '<form id="publish-form" method="POST" action="/publish" enctype="multipart/form-data">' +

          '<div class="field">' +

            '<label for="message">' +
              "Post Content" +
            "</label>" +

            '<div class="textarea-wrap">' +

              '<textarea id="message" name="message" rows="7" placeholder="What would you like to share with your audience?"></textarea>' +

              '<div class="textarea-footer">' +
                '<span>Write your message above</span>' +
                '<span id="char-count">0 characters</span>' +
              "</div>" +

            "</div>" +

          "</div>" +

          '<div class="field">' +

            '<label for="media">Media Attachment</label>' +

            '<label class="upload-box" for="media">' +

              '<div class="upload-icon">↑</div>' +

              '<div class="upload-content">' +
                '<strong id="upload-title">Add an image or video</strong>' +
                '<span id="upload-name">PNG, JPG, WEBP, MP4 and other supported formats</span>' +
              "</div>" +

              '<div class="upload-action">Browse</div>' +

              '<input id="media" type="file" name="media" accept="image/*,video/*" />' +

            "</label>" +

            '<div class="upload-hint">' +
              "Optional • Leave empty if you want to publish text only" +
            "</div>" +

          "</div>" +

          '<div class="publish-footer">' +

            '<div class="publish-info">' +
              '<span class="secure-icon">✓</span>' +
              '<span>Ready to publish securely to your selected Pages</span>' +
            "</div>" +

            '<button class="publish-btn" type="submit" onclick="return validatePublish()">' +
              '<span class="publish-btn-icon">➤</span>' +
              "<span>Publish to Selected Pages</span>" +
            "</button>" +

          "</div>" +

        "</form>" +

      "</section>";
  }

  const totalPages = pages.length;

  const script =
    "<script>" +

      "function updateSelectedCount(){" +

        "const checked=document.querySelectorAll('.page-checkbox:checked');" +

        "const counter=document.getElementById('selected-count');" +

        "if(counter){" +

          "counter.innerHTML='<span class=\"selection-dot\"></span>'+checked.length+' Page'+(checked.length===1?'':'s')+' Selected';" +

        "}" +

        "document.querySelectorAll('.page-row').forEach(function(row){" +

          "const checkbox=row.querySelector('.page-checkbox');" +

          "if(checkbox){" +

            "row.classList.toggle('selected',checkbox.checked);" +

          "}" +

        "});" +

      "}" +

      "function selectAccountPages(accountId,select){" +

        "document.querySelectorAll('.account-'+accountId).forEach(function(c){c.checked=select;});" +

        "updateSelectedCount();" +

      "}" +

      "document.addEventListener('change',function(e){" +

        "if(e.target&&e.target.classList.contains('page-checkbox')){" +
          "updateSelectedCount();" +
        "}" +

        "if(e.target&&e.target.id==='media'){" +

          "const file=e.target.files&&e.target.files[0];" +

          "const title=document.getElementById('upload-title');" +

          "const name=document.getElementById('upload-name');" +

          "if(file){" +

            "if(title){title.textContent='Media selected';}" +

            "if(name){name.textContent=file.name+' • '+formatFileSize(file.size);}" +

          "}else{" +

            "if(title){title.textContent='Add an image or video';}" +

            "if(name){name.textContent='PNG, JPG, WEBP, MP4 and other supported formats';}" +

          "}" +

        "}" +

      "});" +

      "function formatFileSize(bytes){" +

        "if(bytes<1024)return bytes+' B';" +

        "if(bytes<1024*1024)return (bytes/1024).toFixed(1)+' KB';" +

        "if(bytes<1024*1024*1024)return (bytes/(1024*1024)).toFixed(1)+' MB';" +

        "return (bytes/(1024*1024*1024)).toFixed(1)+' GB';" +

      "}" +

      "const messageBox=document.getElementById('message');" +

      "const charCount=document.getElementById('char-count');" +

      "if(messageBox&&charCount){" +

        "messageBox.addEventListener('input',function(){" +

          "charCount.textContent=this.value.length+' characters';" +

        "});" +

      "}" +

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

        "const button=document.querySelector('.publish-btn');" +

        "if(button){" +
          "button.disabled=true;" +
          "button.querySelector('span:last-child').textContent='Publishing...';" +
        "}" +

        "return true;" +

      "}" +

      "updateSelectedCount();" +

    "</script>";

  return page(
    APP_NAME,

    '<header class="topbar">' +

      '<div class="topbar-inner">' +

        '<a href="/" class="brand-link">' +

          '<div class="brand-mark">' +
            '<span>✦</span>' +
          "</div>" +

          '<div class="brand-text">' +
            '<div class="brand">Meta Publisher</div>' +
            '<div class="subtitle">Multi Page Management</div>' +
          "</div>" +

        "</a>" +

        '<div class="top-actions">' +

          '<a class="connect-btn" href="/auth/meta">' +
            '<span class="connect-icon">+</span>' +
            "<span>Connect Facebook Account</span>" +
          "</a>" +

          '<form method="POST" action="/logout" class="logout-form">' +

            '<button class="logout-btn" type="submit" title="Logout">' +
              '<span>↪</span>' +
              "<span>Logout</span>" +
            "</button>" +

          "</form>" +

        "</div>" +

      "</div>" +

    "</header>" +

    '<main class="dashboard">' +

      '<div class="container">' +

        '<section class="hero">' +

          '<div class="hero-content">' +

            '<div class="hero-kicker">' +
              '<span class="hero-live-dot"></span>' +
              "PUBLISHING DASHBOARD" +
            "</div>" +

            "<h1>Manage your Facebook Pages<br><span>from one place.</span></h1>" +

            "<p>" +
              "Connect multiple Facebook accounts, select your Pages, and publish content to them in seconds." +
            "</p>" +

            '<div class="hero-actions">' +
              '<a class="hero-connect" href="/auth/meta">' +
                '<span>＋</span>' +
                "Connect Facebook Account" +
              "</a>" +
              '<span class="hero-note">Supports multiple accounts & Pages</span>' +
            "</div>" +

          "</div>" +

          '<div class="hero-visual">' +

            '<div class="hero-orbit orbit-one"></div>' +
            '<div class="hero-orbit orbit-two"></div>' +

            '<div class="hero-panel">' +

              '<div class="mini-panel-top">' +
                '<span class="mini-dot"></span>' +
                "PUBLISH CENTER" +
                '<span class="mini-status">LIVE</span>' +
              "</div>" +

              '<div class="mini-post">' +

                '<div class="mini-avatar">f</div>' +

                '<div class="mini-lines">' +
                  '<span></span>' +
                  '<span></span>' +
                  '<span class="short"></span>' +
                "</div>" +

              "</div>" +

              '<div class="mini-pages">' +
                '<span class="mini-page active"></span>' +
                '<span class="mini-page"></span>' +
                '<span class="mini-page"></span>' +
                '<span class="mini-page"></span>' +
                '<span class="mini-more">+100</span>' +
              "</div>" +

              '<div class="mini-publish">✓ Ready to publish</div>' +

            "</div>" +

          "</div>" +

        "</section>" +

        '<section class="stats-grid">' +

          '<div class="stat-card">' +
            '<div class="stat-icon stat-blue">♟</div>' +
            '<div class="stat-info">' +
              '<span>Connected Accounts</span>' +
              '<strong>' +
                accounts.length +
              "</strong>" +
            "</div>" +
            '<div class="stat-arrow">→</div>' +
          "</div>" +

          '<div class="stat-card">' +
            '<div class="stat-icon stat-purple">▦</div>' +
            '<div class="stat-info">' +
              '<span>Total Facebook Pages</span>' +
              '<strong>' +
                totalPages +
              "</strong>" +
            "</div>" +
            '<div class="stat-arrow">→</div>' +
          "</div>" +

          '<div class="stat-card">' +
            '<div class="stat-icon stat-green">✓</div>' +
            '<div class="stat-info">' +
              '<span>Publishing Status</span>' +
              '<strong class="stat-online">Ready</strong>' +
            "</div>" +
            '<div class="stat-live"><span></span> Online</div>' +
          "</div>" +

        "</section>" +

        '<div class="content-heading">' +

          '<div>' +
            '<div class="section-eyebrow">ACCOUNTS & PAGES</div>' +
            "<h2>Your Connected Accounts</h2>" +
            "<p>Manage your Facebook accounts and choose which Pages should receive your posts.</p>" +
          "</div>" +

          '<div class="account-limit">' +
            '<span class="limit-dot"></span>' +
            accounts.length +
            "/2 Accounts Connected" +
          "</div>" +

        "</div>" +

        accountHtml +

        publisherHtml +

        '<div class="dashboard-footer">' +
          '<span>Meta Multi Page Publisher</span>' +
          '<span class="footer-separator">•</span>' +
          '<span>Secure publishing dashboard</span>' +
        "</div>" +

      "</div>" +

    "</main>" +

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

      '<div class="error-page-wrap">' +

        '<div class="error-box">' +

          '<div class="error-icon">!</div>' +

          "<h2>Facebook Login Error</h2>" +

          "<p>" +
            escapeHtml(error) +
          "</p>" +

          "<p>" +
            escapeHtml(
              errorDescription || ""
            ) +
          "</p>" +

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

        '<div class="result-main">' +

          '<div class="result-avatar">f</div>' +

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
              ? "✓ Published"
              : "✕ Failed"
          ) +
        "</div>" +

        (
          r.success

            ? (
                r.postId
                  ? '<div class="result-error result-extra">' +
                    "Post ID: " +
                    escapeHtml(
                      r.postId
                    ) +
                    "</div>"
                  : ""
              )

            : '<div class="result-error result-extra">' +
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

      '<div class="results-card">' +

        '<div class="results-icon">' +
          (
            successCount === results.length
              ? "✓"
              : "!"
          ) +
        "</div>" +

        "<h2>Publish Results</h2>" +

        '<div class="result-summary">' +
          "<strong>" +
            successCount +
          "</strong>" +
          " successful out of " +
          "<strong>" +
            results.length +
          "</strong>" +
          " Pages" +
        "</div>" +

        '<div class="results-list">' +
          resultsHtml +
        "</div>" +

        '<a class="back-btn" href="/">' +
          "← Back to Dashboard" +
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

    ":root{--blue:#1877f2;--blue-dark:#0f5ed7;--blue-soft:#edf5ff;--ink:#101828;--text:#344054;--muted:#667085;--line:#e6eaf0;--bg:#f5f7fb;--white:#fff;--green:#12b76a;--red:#d92d20;--shadow:0 12px 35px rgba(16,24,40,.07)}",

    "html{scroll-behavior:smooth}",

    "body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}",

    "button,input,textarea{font-family:inherit}",

    "button{cursor:pointer}",

    "a{color:inherit}",


    /* TOPBAR */

    ".topbar{height:76px;background:rgba(255,255,255,.96);border-bottom:1px solid #e9edf3;display:flex;align-items:center;position:sticky;top:0;z-index:50;backdrop-filter:blur(16px)}",

    ".topbar-inner{width:100%;max-width:1240px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:20px}",

    ".brand-link{text-decoration:none;display:flex;align-items:center;gap:12px}",

    ".brand-mark{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#1877f2,#6d5dfc);display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:900;box-shadow:0 7px 18px rgba(24,119,242,.25)}",

    ".brand-text{line-height:1}",

    ".brand{font-size:17px;font-weight:800;letter-spacing:-.3px;color:#101828}",

    ".subtitle{font-size:10px;color:#98a2b3;margin-top:5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase}",

    ".top-actions{display:flex;align-items:center;gap:10px}",

    ".connect-btn{height:42px;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--blue);color:#fff;text-decoration:none;padding:0 16px;border-radius:10px;font-size:13px;font-weight:750;box-shadow:0 5px 14px rgba(24,119,242,.18);transition:.2s ease}",

    ".connect-btn:hover{background:var(--blue-dark);transform:translateY(-1px);box-shadow:0 8px 18px rgba(24,119,242,.25)}",

    ".connect-icon{font-size:19px;line-height:1}",

    ".logout-form{margin:0}",

    ".logout-btn{height:42px;border:1px solid #e4e7ec;background:#fff;color:#475467;border-radius:10px;padding:0 13px;display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;transition:.2s}",

    ".logout-btn:hover{border-color:#cfd5df;background:#f9fafb;color:#101828}",


    /* MAIN */

    ".dashboard{min-height:calc(100vh - 76px);background:radial-gradient(circle at 50% -10%,rgba(24,119,242,.08),transparent 32%),#f5f7fb}",

    ".container{max-width:1240px;margin:0 auto;padding:30px 24px 70px}",


    /* HERO */

    ".hero{position:relative;overflow:hidden;min-height:330px;border-radius:24px;background:linear-gradient(120deg,#0d47a1 0%,#1877f2 46%,#5865f2 100%);box-shadow:0 18px 50px rgba(24,75,160,.18);display:flex;align-items:center;padding:46px 52px;margin-bottom:20px}",

    ".hero:before{content:'';position:absolute;width:500px;height:500px;border-radius:50%;right:-180px;top:-260px;background:rgba(255,255,255,.09)}",

    ".hero:after{content:'';position:absolute;width:360px;height:360px;border-radius:50%;left:-210px;bottom:-280px;background:rgba(255,255,255,.07)}",

    ".hero-content{position:relative;z-index:2;max-width:670px}",

    ".hero-kicker{display:flex;align-items:center;gap:8px;color:rgba(255,255,255,.78);font-size:11px;font-weight:800;letter-spacing:1.3px;margin-bottom:15px}",

    ".hero-live-dot{width:7px;height:7px;border-radius:50%;background:#65e6a4;box-shadow:0 0 0 4px rgba(101,230,164,.14)}",

    ".hero h1{margin:0;color:#fff;font-size:39px;line-height:1.12;letter-spacing:-1.5px;font-weight:800}",

    ".hero h1 span{color:#dce9ff}",

    ".hero p{margin:16px 0 23px;max-width:610px;color:rgba(255,255,255,.78);font-size:15px;line-height:1.65}",

    ".hero-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}",

    ".hero-connect{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#1554a4;text-decoration:none;border-radius:10px;padding:12px 17px;font-size:13px;font-weight:800;box-shadow:0 8px 20px rgba(0,0,0,.12);transition:.2s}",

    ".hero-connect:hover{transform:translateY(-2px);box-shadow:0 12px 25px rgba(0,0,0,.18)}",

    ".hero-connect span{font-size:18px}",

    ".hero-note{color:rgba(255,255,255,.58);font-size:11px}",


    /* HERO VISUAL */

    ".hero-visual{position:absolute;right:65px;top:50%;transform:translateY(-50%);width:330px;height:250px;z-index:1}",

    ".hero-orbit{position:absolute;border:1px solid rgba(255,255,255,.13);border-radius:50%}",

    ".orbit-one{width:300px;height:300px;right:-35px;top:-25px}",

    ".orbit-two{width:220px;height:220px;right:5px;top:15px}",

    ".hero-panel{position:absolute;width:245px;right:20px;top:22px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.12);border-radius:16px;padding:17px;backdrop-filter:blur(18px);box-shadow:0 20px 50px rgba(0,0,0,.18);transform:rotate(2deg)}",

    ".mini-panel-top{display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.85);font-size:8px;font-weight:800;letter-spacing:1px}",

    ".mini-dot{width:6px;height:6px;border-radius:50%;background:#65e6a4}",

    ".mini-status{margin-left:auto;padding:3px 6px;border-radius:5px;background:rgba(101,230,164,.16);color:#8ef0bd;font-size:7px}",

    ".mini-post{margin-top:18px;padding:14px;border-radius:11px;background:rgba(255,255,255,.95);display:flex;gap:10px}",

    ".mini-avatar{width:29px;height:29px;border-radius:8px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px}",

    ".mini-lines{padding-top:3px;flex:1}",

    ".mini-lines span{display:block;height:6px;border-radius:4px;background:#dce2eb;margin-bottom:6px}",

    ".mini-lines .short{width:55%}",

    ".mini-pages{display:flex;align-items:center;margin-top:14px;gap:5px}",

    ".mini-page{width:25px;height:25px;border-radius:7px;background:rgba(255,255,255,.25);border:1px solid rgba(255,255,255,.3)}",

    ".mini-page.active{background:#fff;position:relative}",

    ".mini-page.active:after{content:'f';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#1877f2;font-weight:900;font-size:13px}",

    ".mini-more{font-size:8px;color:#fff;font-weight:700}",

    ".mini-publish{margin-top:13px;background:rgba(101,230,164,.13);border:1px solid rgba(101,230,164,.2);color:#9af2c4;padding:8px;border-radius:8px;text-align:center;font-size:9px;font-weight:800}",


    /* STATS */

    ".stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:38px}",

    ".stat-card{background:#fff;border:1px solid #e9edf3;border-radius:16px;padding:17px 18px;display:flex;align-items:center;gap:13px;box-shadow:0 5px 20px rgba(16,24,40,.035);transition:.2s}",

    ".stat-card:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(16,24,40,.06)}",

    ".stat-icon{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;flex:0 0 auto}",

    ".stat-blue{background:#edf5ff;color:#1877f2}",

    ".stat-purple{background:#f2efff;color:#6655e8}",

    ".stat-green{background:#ecfdf3;color:#12b76a}",

    ".stat-info{display:flex;flex-direction:column;gap:4px;flex:1}",

    ".stat-info span{font-size:11px;color:#667085;font-weight:600}",

    ".stat-info strong{font-size:22px;line-height:1;color:#101828;letter-spacing:-.5px}",

    ".stat-online{color:#12b76a!important;font-size:18px!important}",

    ".stat-arrow{color:#b3bac5;font-size:18px}",

    ".stat-live{font-size:10px;color:#12b76a;font-weight:750;display:flex;align-items:center;gap:5px}",

    ".stat-live span{width:6px;height:6px;border-radius:50%;background:#12b76a}",


    /* CONTENT HEADING */

    ".content-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:18px}",

    ".section-eyebrow{font-size:10px;color:#1877f2;font-weight:850;letter-spacing:1.2px;margin-bottom:6px}",

    ".content-heading h2{margin:0;font-size:23px;letter-spacing:-.5px;color:#101828}",

    ".content-heading p{margin:6px 0 0;color:#667085;font-size:12px}",

    ".account-limit{display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #e4e7ec;border-radius:9px;padding:8px 11px;color:#667085;font-size:11px;font-weight:700}",

    ".limit-dot{width:6px;height:6px;border-radius:50%;background:#1877f2}",


    /* ACCOUNT CARD */

    ".account-card{background:#fff;border:1px solid #e4e8ee;border-radius:17px;box-shadow:0 7px 25px rgba(16,24,40,.045);margin-bottom:15px;overflow:hidden;transition:.2s}",

    ".account-card:hover{box-shadow:0 10px 32px rgba(16,24,40,.07)}",

    ".account-header{padding:20px 21px;display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #eef1f5}",

    ".account-main{display:flex;align-items:center;gap:13px;min-width:0}",

    ".facebook-account-icon{width:47px;height:47px;flex:0 0 auto;border-radius:13px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:27px;font-weight:900;box-shadow:0 7px 15px rgba(24,119,242,.18)}",

    ".account-title-wrap{min-width:0}",

    ".account-label{font-size:8px;letter-spacing:1.1px;color:#98a2b3;font-weight:850;margin-bottom:4px}",

    ".account-header h2{margin:0 0 6px;font-size:16px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".facebook-id{display:flex;align-items:center;gap:6px;color:#98a2b3;font-size:10px}",

    ".facebook-id span{font-size:8px;background:#f2f4f7;color:#667085;border-radius:4px;padding:3px 5px;font-weight:800}",

    ".account-header-right{display:flex;align-items:center;gap:16px}",

    ".account-page-count{display:flex;align-items:baseline;gap:5px;padding-right:15px;border-right:1px solid #eaecf0}",

    ".account-page-count strong{font-size:21px;color:#101828}",

    ".account-page-count span{font-size:10px;color:#98a2b3;font-weight:650}",

    ".account-actions{display:flex;gap:7px;align-items:center}",

    ".account-actions form{margin:0}",

    ".btn{border:0;border-radius:8px;height:36px;padding:0 11px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;font-weight:800;transition:.2s}",

    ".btn-blue{background:#1877f2;color:#fff;box-shadow:0 4px 10px rgba(24,119,242,.14)}",

    ".btn-blue:hover{background:#0f68df;transform:translateY(-1px)}",

    ".btn-light-danger{background:#fff;border:1px solid #f1d4d2;color:#d92d20}",

    ".btn-light-danger:hover{background:#fff5f4;border-color:#e9aaa5}",

    ".btn-icon{font-size:14px}",


    /* PAGES */

    ".pages-section{padding:18px 21px 21px}",

    ".pages-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:13px}",

    ".pages-section-title{font-size:12px;font-weight:800;color:#344054}",

    ".pages-section-subtitle{font-size:10px;color:#98a2b3;margin-top:3px}",

    ".select-actions{display:flex;gap:6px}",

    ".tool-btn{background:#fff;color:#475467;border:1px solid #e4e7ec;border-radius:7px;padding:7px 9px;cursor:pointer;font-size:10px;font-weight:750;transition:.2s}",

    ".tool-btn:hover{background:#f8fafc;border-color:#cfd5df;color:#101828}",

    ".tool-btn span{color:#1877f2;margin-right:3px}",

    ".page-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",

    ".page-row{position:relative;display:flex;align-items:center;gap:10px;min-height:59px;padding:9px 11px;background:#fafbfc;border:1px solid #eaecf0;border-radius:10px;cursor:pointer;transition:.18s}",

    ".page-row:hover{background:#f7faff;border-color:#b9d4f7;transform:translateY(-1px)}",

    ".page-row.selected{background:#f1f7ff;border-color:#91bff5;box-shadow:0 0 0 1px rgba(24,119,242,.05)}",

    ".page-checkbox{position:absolute;opacity:0;width:1px;height:1px}",

    ".page-avatar{width:35px;height:35px;flex:0 0 auto;border-radius:9px;background:linear-gradient(135deg,#1877f2,#4c8ef7);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px}",

    ".page-info{min-width:0;flex:1}",

    ".page-name{font-size:12px;font-weight:800;margin-bottom:5px;color:#1d2939;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".page-meta{font-size:9px;color:#98a2b3;display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden}",

    ".online-dot{width:5px;height:5px;border-radius:50%;background:#12b76a;flex:0 0 auto}",

    ".meta-separator{color:#d0d5dd}",

    ".page-select-indicator{width:21px;height:21px;border:1.5px solid #d0d5dd;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:.18s}",

    ".checkmark{opacity:0;color:#fff;font-size:12px;font-weight:900;transform:scale(.6);transition:.18s}",

    ".page-row.selected .page-select-indicator{background:#1877f2;border-color:#1877f2}",

    ".page-row.selected .checkmark{opacity:1;transform:scale(1)}",

    ".no-pages{display:flex;align-items:center;gap:12px;background:#f8fafc;border:1px dashed #dfe3e8;border-radius:10px;padding:16px}",

    ".no-pages-icon{width:35px;height:35px;border-radius:9px;background:#eef2f6;color:#98a2b3;display:flex;align-items:center;justify-content:center;font-size:18px}",

    ".no-pages strong{font-size:11px;color:#475467}",

    ".no-pages p{margin:3px 0 0;color:#98a2b3;font-size:10px}",


    /* PUBLISHER */

    ".publisher-card{background:#fff;border:1px solid #e4e8ee;border-radius:19px;box-shadow:0 9px 30px rgba(16,24,40,.055);margin-top:25px;padding:25px}",

    ".publisher-top{display:flex;align-items:center;justify-content:space-between;gap:15px}",

    ".publisher-title-area{display:flex;align-items:center;gap:12px}",

    ".composer-icon{width:43px;height:43px;border-radius:12px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:800}",

    ".publisher-card h2{margin:0;font-size:18px;letter-spacing:-.3px}",

    ".publisher-card p{margin:4px 0 0;color:#667085;font-size:11px}",

    ".selection-badge{display:flex;align-items:center;gap:7px;background:#edf5ff;color:#1769d2;border-radius:20px;padding:8px 11px;font-size:10px;font-weight:800}",

    ".selection-dot{width:6px;height:6px;border-radius:50%;background:#1877f2}",

    ".publisher-divider{height:1px;background:#eef1f5;margin:21px 0}",

    ".field{margin-bottom:19px}",

    ".field label{display:block;font-size:11px;color:#344054;font-weight:800;margin-bottom:8px}",

    ".textarea-wrap{border:1px solid #dfe3e8;border-radius:11px;overflow:hidden;transition:.2s}",

    ".textarea-wrap:focus-within{border-color:#91bff5;box-shadow:0 0 0 3px rgba(24,119,242,.08)}",

    "textarea{width:100%;resize:vertical;border:0;padding:14px 15px 10px;min-height:145px;font-size:13px;line-height:1.6;color:#101828;outline:none}",

    "textarea::placeholder{color:#98a2b3}",

    ".textarea-footer{display:flex;align-items:center;justify-content:space-between;padding:7px 12px;border-top:1px solid #f0f2f5;background:#fafbfc;color:#98a2b3;font-size:9px}",

    ".upload-box{min-height:74px!important;display:flex!important;align-items:center!important;gap:12px!important;border:1px dashed #b9c3d0!important;border-radius:11px!important;padding:12px 14px!important;background:#fbfcfe!important;cursor:pointer!important;transition:.2s!important}",

    ".upload-box:hover{background:#f5f9ff!important;border-color:#1877f2!important}",

    ".upload-icon{width:39px;height:39px;flex:0 0 auto;border-radius:10px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900}",

    ".upload-content{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}",

    ".upload-content strong{font-size:11px;color:#344054}",

    ".upload-content span{font-size:9px;color:#98a2b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".upload-action{border:1px solid #dfe3e8;background:#fff;color:#475467;border-radius:7px;padding:7px 10px;font-size:9px;font-weight:800}",

    ".upload-box input{display:none}",

    ".upload-hint{font-size:9px;color:#98a2b3;margin-top:7px}",

    ".publish-footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding-top:4px}",

    ".publish-info{display:flex;align-items:center;gap:7px;color:#667085;font-size:10px}",

    ".secure-icon{width:20px;height:20px;border-radius:50%;background:#ecfdf3;color:#12b76a;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900}",

    ".publish-btn{height:45px;border:0;background:linear-gradient(135deg,#1877f2,#1769d2);color:#fff;padding:0 17px;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:11px;font-weight:850;cursor:pointer;box-shadow:0 7px 17px rgba(24,119,242,.2);transition:.2s}",

    ".publish-btn:hover{transform:translateY(-1px);box-shadow:0 10px 23px rgba(24,119,242,.28)}",

    ".publish-btn:disabled{opacity:.7;cursor:wait;transform:none}",

    ".publish-btn-icon{font-size:13px}",


    /* EMPTY */

    ".empty-state{background:#fff;border:1px solid #e4e8ee;border-radius:17px;padding:55px 30px;text-align:center;box-shadow:0 7px 25px rgba(16,24,40,.04)}",

    ".empty-illustration{display:flex;justify-content:center;margin-bottom:15px}",

    ".empty-illustration-circle{width:65px;height:65px;border-radius:19px;background:linear-gradient(135deg,#1877f2,#5b8ff5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:900;box-shadow:0 10px 22px rgba(24,119,242,.2)}",

    ".empty-state h3{margin:0;font-size:17px}",

    ".empty-state p{max-width:470px;margin:8px auto 20px;color:#667085;font-size:12px;line-height:1.6}",

    ".empty-connect-btn{display:inline-flex;align-items:center;gap:7px;background:#1877f2;color:#fff;text-decoration:none;padding:11px 15px;border-radius:9px;font-size:11px;font-weight:800}",


    /* FOOTER */

    ".dashboard-footer{display:flex;align-items:center;justify-content:center;gap:8px;color:#98a2b3;font-size:9px;padding-top:28px}",

    ".footer-separator{color:#d0d5dd}",


    /* RESULTS */

    ".results-page{min-height:calc(100vh - 76px);padding:45px 20px;background:#f5f7fb}",

    ".results-card{max-width:850px;margin:0 auto;background:#fff;border:1px solid #e4e8ee;border-radius:18px;padding:30px;box-shadow:0 10px 35px rgba(16,24,40,.07)}",

    ".results-icon{width:55px;height:55px;border-radius:16px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:27px;font-weight:900;margin-bottom:15px}",

    ".results-card h2{margin:0;font-size:22px}",

    ".result-summary{margin:8px 0 22px;color:#667085;font-size:12px}",

    ".results-list{display:flex;flex-direction:column;gap:8px}",

    ".result-row{border:1px solid #e4e7ec;border-radius:10px;padding:12px;display:grid;grid-template-columns:1fr auto;gap:7px 15px}",

    ".result-success{background:#f6fffa;border-color:#ccebd9}",

    ".result-failed{background:#fff8f7;border-color:#f0d0cc}",

    ".result-main{display:flex;align-items:center;gap:9px}",

    ".result-avatar{width:33px;height:33px;border-radius:8px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}",

    ".result-row strong{font-size:12px}",

    ".result-page-id{margin-top:4px;color:#98a2b3;font-size:9px}",

    ".result-status{font-size:10px;font-weight:850;align-self:center}",

    ".result-success .result-status{color:#12b76a}",

    ".result-failed .result-status{color:#d92d20}",

    ".result-extra{grid-column:1/-1}",

    ".result-error{color:#667085;font-size:9px;word-break:break-word}",

    ".back-btn{display:inline-flex;align-items:center;margin-top:20px;padding:10px 14px;background:#1877f2;color:#fff;text-decoration:none;border-radius:8px;font-size:11px;font-weight:800}",


    /* ERROR */

    ".error-page-wrap{min-height:100vh;padding:50px 20px;background:#f5f7fb}",

    ".error-box{max-width:900px;margin:0 auto;background:#fff;border:1px solid #eadbd9;border-radius:17px;padding:30px;box-shadow:0 10px 35px rgba(16,24,40,.06)}",

    ".error-icon{width:45px;height:45px;border-radius:12px;background:#fff0ee;color:#d92d20;display:flex;align-items:center;justify-content:center;font-size:23px;font-weight:900;margin-bottom:13px}",

    ".error-box h2{margin:0 0 6px}",

    ".error-lead{color:#667085;font-size:12px}",

    "pre{background:#f8f9fb;border:1px solid #eaecf0;padding:14px;border-radius:9px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11px;color:#475467}",


    /* LOGIN */

    ".login-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:25px;background:radial-gradient(circle at 10% 10%,rgba(24,119,242,.12),transparent 30%),radial-gradient(circle at 90% 90%,rgba(88,101,242,.11),transparent 30%),#f5f7fb;position:relative;overflow:hidden}",

    ".login-decoration{position:absolute;border-radius:50%;border:1px solid rgba(24,119,242,.08)}",

    ".login-decoration-one{width:500px;height:500px;left:-300px;top:-260px}",

    ".login-decoration-two{width:430px;height:430px;right:-260px;bottom:-240px}",

    ".login-card{position:relative;width:100%;max-width:430px;background:rgba(255,255,255,.96);border:1px solid #e4e8ee;border-radius:20px;box-shadow:0 25px 70px rgba(16,24,40,.1);padding:30px;z-index:2}",

    ".login-brand{display:flex;align-items:center;gap:10px;margin-bottom:30px}",

    ".login-brand-icon{width:39px;height:39px;border-radius:11px;background:linear-gradient(135deg,#1877f2,#6d5dfc);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px}",

    ".login-brand-name{font-size:14px;font-weight:850;color:#101828}",

    ".login-brand-sub{font-size:8px;color:#98a2b3;text-transform:uppercase;letter-spacing:.7px;margin-top:3px}",

    ".login-title-area{text-align:center}",

    ".lock-circle{width:55px;height:55px;margin:0 auto 13px;border-radius:17px;background:#edf5ff;display:flex;align-items:center;justify-content:center;font-size:25px}",

    ".login-card h1{margin:0 0 7px;font-size:25px;letter-spacing:-.7px}",

    ".login-card p{margin:0;color:#667085;font-size:12px;line-height:1.6}",

    ".login-error{display:flex;align-items:center;gap:8px;background:#fff5f4;border:1px solid #f3d0cc;color:#d92d20;padding:10px 11px;border-radius:9px;margin:18px 0 0;font-size:10px}",

    ".login-error-icon{width:17px;height:17px;border-radius:50%;background:#d92d20;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900}",

    ".login-form{margin-top:22px}",

    ".login-field label{display:block;font-size:10px;font-weight:800;color:#344054;margin-bottom:7px}",

    ".password-wrap{position:relative}",

    ".input-icon{position:absolute;left:13px;top:50%;transform:translateY(-50%);font-size:8px;color:#98a2b3}",

    ".login-card input[type=password]{width:100%;height:45px;padding:0 13px 0 31px;border:1px solid #dfe3e8;border-radius:9px;font-size:12px;outline:none;background:#fff;transition:.2s}",

    ".login-card input[type=password]:focus{border-color:#91bff5;box-shadow:0 0 0 3px rgba(24,119,242,.08)}",

    ".login-btn{width:100%;height:45px;border:0;background:linear-gradient(135deg,#1877f2,#1769d2);color:#fff;border-radius:9px;font-size:12px;font-weight:850;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;margin-top:12px;box-shadow:0 7px 18px rgba(24,119,242,.2);transition:.2s}",

    ".login-btn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(24,119,242,.27)}",

    ".login-arrow{font-size:17px}",

    ".login-footer{display:flex;align-items:center;justify-content:center;gap:6px;color:#98a2b3;font-size:9px;margin-top:21px;padding-top:18px;border-top:1px solid #eef1f5}",

    ".status-dot{width:6px;height:6px;border-radius:50%;background:#12b76a}",


    /* RESPONSIVE */

    "@media(max-width:1050px){.hero-visual{right:20px;opacity:.45}.hero-content{max-width:650px}.hero{padding-left:38px}}",

    "@media(max-width:800px){.topbar{height:auto;min-height:70px}.topbar-inner{padding:12px 16px}.brand-text{display:none}.top-actions{margin-left:auto}.container{padding:20px 15px 50px}.hero{min-height:360px;padding:35px 25px;border-radius:19px}.hero h1{font-size:32px}.hero-visual{display:none}.stats-grid{grid-template-columns:1fr;gap:9px;margin-bottom:30px}.content-heading{align-items:flex-start;flex-direction:column}.account-header{align-items:flex-start;flex-direction:column}.account-header-right{width:100%;justify-content:space-between}.account-page-count{display:none}.account-actions{margin-left:auto}.page-list{grid-template-columns:1fr}.publisher-card{padding:19px}.publisher-top{align-items:flex-start;flex-direction:column}.publish-footer{align-items:stretch;flex-direction:column}.publish-btn{width:100%}}",

    "@media(max-width:520px){.connect-btn span:last-child{display:none}.connect-btn{width:42px;padding:0}.logout-btn span:last-child{display:none}.logout-btn{width:42px;padding:0;justify-content:center}.hero{padding:30px 21px;min-height:390px}.hero h1{font-size:27px}.hero p{font-size:13px}.hero-actions{align-items:flex-start;flex-direction:column}.hero-note{font-size:10px}.account-actions{width:100%;display:grid;grid-template-columns:1fr 1fr}.account-actions form{width:100%}.account-actions .btn{width:100%;justify-content:center}.pages-toolbar{align-items:flex-start;flex-direction:column}.select-actions{width:100%}.tool-btn{flex:1}.upload-box{flex-wrap:wrap}.upload-action{margin-left:auto}.login-card{padding:23px}.dashboard-footer{flex-wrap:wrap}.results-card{padding:22px}}"

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
