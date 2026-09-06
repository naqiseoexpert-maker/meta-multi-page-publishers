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

      '<div class="login-glow login-glow-one"></div>' +
      '<div class="login-glow login-glow-two"></div>' +

      '<div class="login-card">' +

        '<div class="login-brand">' +
          '<div class="login-logo">' +
            '<span>f</span>' +
          "</div>" +

          "<div>" +
            '<div class="login-brand-name">Meta Publisher</div>' +
            '<div class="login-brand-sub">Publishing Command Center</div>' +
          "</div>" +
        "</div>" +

        '<div class="login-title-area">' +

          '<div class="login-lock">' +
            '<span>⌁</span>' +
          "</div>" +

          '<div class="login-eyebrow">PRIVATE WORKSPACE</div>' +

          "<h1>Welcome back.</h1>" +

          "<p>" +
            "Enter your password to access your Facebook publishing dashboard." +
          "</p>" +

        "</div>" +

        errorHtml +

        '<form method="POST" action="/login" class="login-form">' +

          '<div class="login-field">' +

            '<label for="login-password">Dashboard Password</label>' +

            '<div class="password-wrap">' +

              '<span class="password-symbol">●</span>' +

              '<input id="login-password" type="password" name="password" placeholder="Enter your password" autocomplete="current-password" required autofocus />' +

            "</div>" +

          "</div>" +

          '<button type="submit" class="login-btn">' +
            "<span>Enter Dashboard</span>" +
            '<span class="login-arrow">→</span>' +
          "</button>" +

        "</form>" +

        '<div class="login-secure">' +
          '<span class="secure-pulse"></span>' +
          "Encrypted private workspace" +
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

  const totalPages = pages.length;

  let accountOverviewHtml = "";

  if (accounts.length === 0) {
    accountOverviewHtml =
      '<div class="overview-empty">' +
        '<div class="overview-empty-icon">f</div>' +
        '<div>' +
          '<strong>No Facebook accounts connected</strong>' +
          '<span>Connect your first account to begin.</span>' +
        "</div>" +
      "</div>";
  } else {
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const accountPages = groupedPages[account.id] || [];

      accountOverviewHtml +=
        '<div class="overview-account">' +

          '<div class="overview-account-left">' +

            '<div class="overview-facebook-icon">f</div>' +

            '<div class="overview-account-info">' +

              '<div class="overview-account-name">' +
                escapeHtml(
                  account.account_name ||
                  "Facebook Account"
                ) +
              "</div>" +

              '<div class="overview-account-id">' +
                "ID " +
                escapeHtml(account.facebook_user_id) +
              "</div>" +

            "</div>" +

          "</div>" +

          '<div class="overview-account-pages">' +
            '<strong>' +
              accountPages.length +
            "</strong>" +
            "<span>" +
              "Page" +
              (accountPages.length === 1 ? "" : "s") +
            "</span>" +
          "</div>" +

          '<div class="overview-account-status">' +
            '<span class="status-pulse"></span>' +
            "Connected" +
          "</div>" +

        "</div>";
    }
  }


  let accountHtml = "";

  if (accounts.length === 0) {
    accountHtml =
      '<div class="empty-state">' +

        '<div class="empty-illustration">' +
          '<div class="empty-illustration-circle">f</div>' +
        "</div>" +

        '<div class="empty-eyebrow">GET STARTED</div>' +

        "<h3>No Facebook account connected</h3>" +

        "<p>" +
          "Connect your Facebook account to start managing and publishing to your Pages." +
        "</p>" +

        '<a class="empty-connect-btn" href="/auth/meta">' +
          '<span>+</span>' +
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

              '<div class="pages-title-row">' +
                '<span class="pages-title-dot"></span>' +
                '<div class="pages-section-title">Connected Pages</div>' +
              "</div>" +

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
          const pageName =
            p.page_name || "Unnamed Page";

          const initials =
            getInitials(pageName);

          pageHtml +=
            '<label class="page-row">' +

              '<input class="page-checkbox account-' +
                Number(account.id) +
                '" type="checkbox" name="page_ids" value="' +
                escapeHtml(p.id) +
                '" form="publish-form" />' +

              '<div class="page-avatar">' +
                escapeHtml(initials) +
              "</div>" +

              '<div class="page-info">' +

                '<div class="page-name">' +
                  escapeHtml(pageName) +
                "</div>" +

                '<div class="page-meta">' +
                  '<span class="online-dot"></span>' +
                  "Connected" +
                  '<span class="meta-separator">•</span>' +
                  "ID " +
                  escapeHtml(p.facebook_page_id) +
                "</div>" +

              "</div>" +

              '<div class="page-ready">' +
                "READY" +
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
                  "FACEBOOK ACCOUNT " +
                  String(account.id).padStart(2, "0") +
                "</div>" +

                "<h2>" +
                  escapeHtml(
                    account.account_name ||
                    "Facebook Account"
                  ) +
                "</h2>" +

                '<div class="facebook-id">' +
                  '<span>ACCOUNT ID</span>' +
                  escapeHtml(account.facebook_user_id) +
                "</div>" +

              "</div>" +

            "</div>" +

            '<div class="account-header-right">' +

              '<div class="account-connected-label">' +
                '<span class="status-pulse"></span>' +
                "Connected" +
              "</div>" +

              '<div class="account-page-count">' +
                '<strong>' +
                  accountPages.length +
                "</strong>" +
                "<span>" +
                  "Pages" +
                "</span>" +
              "</div>" +

              '<div class="account-actions">' +

                '<form method="POST" action="/sync">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(account.id) +
                  '" />' +

                  '<button class="btn btn-blue" type="submit">' +
                    '<span class="btn-icon">↻</span>' +
                    "Sync" +
                  "</button>" +

                "</form>" +

                '<form method="POST" action="/remove-account" ' +
                  'onsubmit="return confirm(\'Remove this Facebook account and all its connected Pages?\');">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(account.id) +
                  '" />' +

                  '<button class="btn btn-light-danger" type="submit">' +
                    '<span class="btn-icon">×</span>' +
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

        '<div class="publisher-glow"></div>' +

        '<div class="publisher-top">' +

          '<div class="publisher-title-area">' +

            '<div class="composer-icon">✎</div>' +

            "<div>" +

              '<div class="section-eyebrow">PUBLISHING STUDIO</div>' +

              "<h2>Create & Publish</h2>" +

              "<p>" +
                "Create one post and distribute it across your selected Pages." +
              "</p>" +

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

            '<div class="field-label-row">' +
              '<label for="message">Post Content</label>' +
              '<span id="char-count">0 characters</span>' +
            "</div>" +

            '<div class="textarea-wrap">' +

              '<textarea id="message" name="message" rows="7" placeholder="Write something you want to share with your audience..."></textarea>' +

              '<div class="textarea-footer">' +
                '<span>Compose your Facebook post</span>' +
                '<span>Text + media supported</span>' +
              "</div>" +

            "</div>" +

          "</div>" +

          '<div class="field">' +

            '<label for="media">Media Attachment</label>' +

            '<label class="upload-box" for="media">' +

              '<div class="upload-icon">↑</div>' +

              '<div class="upload-content">' +
                '<strong id="upload-title">Drop your image or video here</strong>' +
                '<span id="upload-name">PNG, JPG, WEBP, MP4 and other supported formats</span>' +
              "</div>" +

              '<div class="upload-action">Browse Files</div>' +

              '<input id="media" type="file" name="media" accept="image/*,video/*" />' +

            "</label>" +

            '<div class="upload-hint">' +
              "Optional attachment • Maximum file size 100 MB" +
            "</div>" +

          "</div>" +

          '<div class="publish-footer">' +

            '<div class="publish-info">' +

              '<div class="publish-check">✓</div>' +

              '<div>' +
                '<strong>Ready to publish</strong>' +
                '<span id="publish-target-info">Select Pages above to choose your audience</span>' +
              "</div>" +

            "</div>" +

            '<button class="publish-btn" type="submit" onclick="return validatePublish()">' +
              '<span class="publish-btn-icon">➤</span>' +
              "<span>Publish Now</span>" +
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

        "const target=document.getElementById('publish-target-info');" +

        "if(counter){" +

          "counter.innerHTML='<span class=\"selection-dot\"></span>'+checked.length+' Page'+(checked.length===1?'':'s')+' Selected';" +

        "}" +

        "if(target){" +

          "target.textContent=checked.length?checked.length+' Page'+(checked.length===1?'':'s')+' selected for publishing':'Select Pages above to choose your audience';" +

        "}" +

        "document.querySelectorAll('.page-row').forEach(function(row){" +

          "const checkbox=row.querySelector('.page-checkbox');" +

          "if(checkbox){" +

            "row.classList.toggle('selected',checkbox.checked);" +

          "}" +

        "});" +

        "const selectedStat=document.getElementById('selected-stat');" +

        "if(selectedStat){selectedStat.textContent=checked.length;}" +

      "}" +


      "function selectAccountPages(accountId,select){" +

        "document.querySelectorAll('.account-'+accountId).forEach(function(c){c.checked=select;});" +

        "updateSelectedCount();" +

      "}" +


      "function selectAllPages(select){" +

        "document.querySelectorAll('.page-checkbox').forEach(function(c){c.checked=select;});" +

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

            "if(title){title.textContent='Media selected successfully';}" +

            "if(name){name.textContent=file.name+' • '+formatFileSize(file.size);}" +

          "}else{" +

            "if(title){title.textContent='Drop your image or video here';}" +

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
            '<span>f</span>' +
          "</div>" +

          '<div class="brand-text">' +
            '<div class="brand">Meta Publisher</div>' +
            '<div class="subtitle">Publishing Command Center</div>' +
          "</div>" +

        "</a>" +

        '<div class="top-actions">' +

          '<div class="top-status">' +
            '<span class="top-status-dot"></span>' +
            "System Online" +
          "</div>" +

          '<a class="connect-btn" href="/auth/meta">' +
            '<span class="connect-icon">+</span>' +
            "<span>Connect Account</span>" +
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

        '<section class="dashboard-hero">' +

          '<div class="hero-left">' +

            '<div class="hero-kicker">' +
              '<span class="hero-live-dot"></span>' +
              "META PUBLISHING COMMAND CENTER" +
            "</div>" +

            "<h1>" +
              "Everything you publish." +
              "<br>" +
              '<span>One powerful dashboard.</span>' +
            "</h1>" +

            "<p>" +
              "Manage your Facebook accounts, organize your Pages and publish content across your entire network from one place." +
            "</p>" +

            '<div class="hero-buttons">' +

              '<a class="hero-primary" href="/auth/meta">' +
                '<span>+</span>' +
                "Connect Facebook Account" +
              "</a>" +

              '<button class="hero-secondary" type="button" onclick="document.getElementById(\'accounts-section\').scrollIntoView({behavior:\'smooth\'})">' +
                "View Accounts" +
                '<span>↓</span>' +
              "</button>" +

            "</div>" +

          "</div>" +

          '<div class="hero-right">' +

            '<div class="hero-grid"></div>' +

            '<div class="floating-card floating-card-main">' +

              '<div class="floating-top">' +
                '<span class="floating-label">NETWORK STATUS</span>' +
                '<span class="floating-live">LIVE</span>' +
              "</div>" +

              '<div class="network-number">' +
                accounts.length +
                '<span> accounts</span>' +
              "</div>" +

              '<div class="network-line">' +
                '<span class="network-dot"></span>' +
                "All connected accounts are available" +
              "</div>" +

              '<div class="network-bars">' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
                '<span></span>' +
              "</div>" +

            "</div>" +

            '<div class="floating-card floating-card-small">' +
              '<div class="small-icon">f</div>' +
              '<div>' +
                '<strong>' +
                  totalPages +
                "</strong>" +
                '<span>Pages ready</span>' +
              "</div>" +
            "</div>" +

          "</div>" +

        "</section>" +


        '<section class="overview-panel">' +

          '<div class="overview-heading">' +

            '<div>' +
              '<div class="section-eyebrow light-blue">NETWORK OVERVIEW</div>' +
              "<h2>Your Accounts</h2>" +
              "<p>Connected Facebook accounts and their available Pages.</p>" +
            "</div>" +

            '<div class="overview-total">' +
              '<span>Total</span>' +
              '<strong>' +
                accounts.length +
              "</strong>" +
              '<small>Accounts</small>' +
            "</div>" +

          "</div>" +


          '<div class="overview-stats">' +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon blue-icon">f</div>' +
              '<div>' +
                '<span>Connected Accounts</span>' +
                '<strong>' +
                  accounts.length +
                "</strong>" +
              "</div>" +
            "</div>" +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon purple-icon">▦</div>' +
              '<div>' +
                '<span>Total Pages</span>' +
                '<strong>' +
                  totalPages +
                "</strong>" +
              "</div>" +
            "</div>" +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon green-icon">✓</div>' +
              '<div>' +
                '<span>Network Status</span>' +
                '<strong class="ready-text">Ready</strong>' +
              "</div>" +
            "</div>" +

          "</div>" +


          '<div class="overview-accounts">' +
            accountOverviewHtml +
          "</div>" +


          '<div class="overview-footer">' +

            '<button type="button" class="overview-select-btn" onclick="selectAllPages(true)">' +
              "✓ Select All Pages" +
            "</button>" +

            '<button type="button" class="overview-clear-btn" onclick="selectAllPages(false)">' +
              "× Clear Selection" +
            "</button>" +

          "</div>" +

        "</section>" +


        '<div id="accounts-section" class="content-heading">' +

          '<div>' +
            '<div class="section-eyebrow">ACCOUNT MANAGEMENT</div>' +
            "<h2>Facebook Accounts & Pages</h2>" +
            "<p>Sync, manage and select the Pages you want to publish to.</p>" +
          "</div>" +

          '<div class="account-limit">' +
            '<span class="limit-dot"></span>' +
            accounts.length +
            " Connected" +
          "</div>" +

        "</div>" +


        accountHtml +


        publisherHtml +


        '<div class="dashboard-footer">' +

          '<div class="footer-brand">' +
            '<span class="footer-logo">f</span>' +
            "<strong>Meta Publisher</strong>" +
          "</div>" +

          '<span class="footer-separator">•</span>' +

          '<span>Secure publishing dashboard</span>' +

          '<span class="footer-separator">•</span>' +

          '<span>All systems operational</span>' +

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

          '<div class="result-avatar">' +
            escapeHtml(getInitials(r.page || "Page")) +
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

        '<div class="results-top">' +

          '<div class="results-icon">' +
            (
              successCount === results.length
                ? "✓"
                : "!"
            ) +
          "</div>" +

          '<div>' +
            '<div class="section-eyebrow">PUBLISHING REPORT</div>' +
            "<h2>Publish Results</h2>" +
          "</div>" +

        "</div>" +

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
   HELPERS
   ========================================================= */

function getInitials(name) {
  const text = String(name || "").trim();

  if (!text) {
    return "P";
  }

  const parts =
    text
      .split(/\s+/)
      .filter(Boolean);

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (
    parts[0].charAt(0) +
    parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}


/* =========================================================
   HTML PAGE + PREMIUM DASHBOARD CSS
   ========================================================= */

function page(
  title,
  content
) {
  const css = [

    "*{box-sizing:border-box}",

    ":root{--blue:#1877f2;--blue2:#4f46e5;--navy:#07152f;--navy2:#0b1d3d;--ink:#101828;--text:#344054;--muted:#667085;--line:#e6eaf0;--bg:#f4f7fb;--white:#fff;--green:#12b76a;--red:#d92d20;--purple:#7c5cff}",

    "html{scroll-behavior:smooth}",

    "body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}",

    "button,input,textarea{font-family:inherit}",

    "button{cursor:pointer}",

    "a{color:inherit}",


    /* TOPBAR */

    ".topbar{height:74px;background:rgba(255,255,255,.94);border-bottom:1px solid #e8edf4;display:flex;align-items:center;position:sticky;top:0;z-index:50;backdrop-filter:blur(18px)}",

    ".topbar-inner{width:100%;max-width:1280px;margin:0 auto;padding:0 25px;display:flex;align-items:center;justify-content:space-between;gap:20px}",

    ".brand-link{text-decoration:none;display:flex;align-items:center;gap:11px}",

    ".brand-mark{width:41px;height:41px;border-radius:12px;background:linear-gradient(135deg,#1877f2,#6655e8);display:flex;align-items:center;justify-content:center;color:#fff;font-size:25px;font-weight:900;box-shadow:0 8px 20px rgba(24,119,242,.24)}",

    ".brand-text{line-height:1}",

    ".brand{font-size:16px;font-weight:850;letter-spacing:-.3px}",

    ".subtitle{font-size:8px;color:#98a2b3;margin-top:5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase}",

    ".top-actions{display:flex;align-items:center;gap:9px}",

    ".top-status{height:38px;padding:0 11px;border:1px solid #e6ebf1;background:#fbfcfe;border-radius:9px;display:flex;align-items:center;gap:7px;color:#667085;font-size:10px;font-weight:750}",

    ".top-status-dot{width:6px;height:6px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 4px rgba(18,183,106,.08)}",

    ".connect-btn{height:38px;display:inline-flex;align-items:center;justify-content:center;gap:7px;background:#1877f2;color:#fff;text-decoration:none;padding:0 14px;border-radius:9px;font-size:11px;font-weight:800;box-shadow:0 5px 14px rgba(24,119,242,.18);transition:.2s}",

    ".connect-btn:hover{background:#0e68df;transform:translateY(-1px)}",

    ".connect-icon{font-size:17px}",

    ".logout-form{margin:0}",

    ".logout-btn{height:38px;border:1px solid #e4e7ec;background:#fff;color:#475467;border-radius:9px;padding:0 11px;display:flex;align-items:center;gap:6px;font-size:10px;font-weight:750;transition:.2s}",

    ".logout-btn:hover{background:#f8fafc}",


    /* MAIN */

    ".dashboard{min-height:calc(100vh - 74px);background:radial-gradient(circle at 50% 0,rgba(24,119,242,.055),transparent 30%),#f4f7fb}",

    ".container{max-width:1280px;margin:0 auto;padding:25px 25px 65px}",


    /* HERO */

    ".dashboard-hero{position:relative;overflow:hidden;min-height:350px;border-radius:24px;background:linear-gradient(115deg,#06132c 0%,#0a2451 48%,#173d85 100%);box-shadow:0 22px 55px rgba(5,27,65,.18);display:flex;align-items:center;padding:48px 52px;margin-bottom:18px}",

    ".dashboard-hero:before{content:'';position:absolute;width:650px;height:650px;border-radius:50%;right:-300px;top:-350px;background:radial-gradient(circle,rgba(79,70,229,.32),transparent 68%)}",

    ".dashboard-hero:after{content:'';position:absolute;width:430px;height:430px;border-radius:50%;left:-280px;bottom:-350px;background:rgba(24,119,242,.12)}",

    ".hero-left{position:relative;z-index:4;max-width:690px}",

    ".hero-kicker{display:flex;align-items:center;gap:8px;color:#91b8f8;font-size:9px;font-weight:900;letter-spacing:1.5px;margin-bottom:15px}",

    ".hero-live-dot{width:7px;height:7px;border-radius:50%;background:#42e59a;box-shadow:0 0 0 5px rgba(66,229,154,.1)}",

    ".dashboard-hero h1{margin:0;color:#fff;font-size:40px;line-height:1.1;letter-spacing:-1.7px;font-weight:850}",

    ".dashboard-hero h1 span{color:#83b2ff}",

    ".dashboard-hero p{max-width:610px;margin:16px 0 24px;color:#9eafca;font-size:13px;line-height:1.7}",

    ".hero-buttons{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",

    ".hero-primary{display:inline-flex;align-items:center;gap:7px;padding:11px 15px;background:#fff;color:#125bbd;text-decoration:none;border-radius:9px;font-size:10px;font-weight:850;box-shadow:0 9px 22px rgba(0,0,0,.15);transition:.2s}",

    ".hero-primary:hover{transform:translateY(-2px)}",

    ".hero-primary span{font-size:17px}",

    ".hero-secondary{height:39px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#c5d3e8;border-radius:9px;padding:0 13px;display:flex;align-items:center;gap:8px;font-size:10px;font-weight:750}",

    ".hero-secondary:hover{background:rgba(255,255,255,.1)}",

    ".hero-secondary span{font-size:14px}",


    /* HERO VISUAL */

    ".hero-right{position:absolute;right:55px;top:50%;width:355px;height:270px;transform:translateY(-50%);z-index:3}",

    ".hero-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);background-size:27px 27px;mask-image:radial-gradient(circle,black 20%,transparent 75%);opacity:.7}",

    ".floating-card{position:absolute;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.08);backdrop-filter:blur(18px);box-shadow:0 25px 55px rgba(0,0,0,.22);border-radius:17px}",

    ".floating-card-main{width:255px;right:35px;top:22px;padding:19px;transform:rotate(2deg)}",

    ".floating-top{display:flex;align-items:center}",

    ".floating-label{font-size:7px;letter-spacing:1.1px;font-weight:900;color:#8ea5c5}",

    ".floating-live{margin-left:auto;background:rgba(66,229,154,.1);border:1px solid rgba(66,229,154,.17);color:#5ee9a4;border-radius:5px;padding:3px 6px;font-size:6px;font-weight:900}",

    ".network-number{color:#fff;font-size:37px;font-weight:850;letter-spacing:-1.5px;margin-top:18px}",

    ".network-number span{font-size:10px;color:#879ab8;font-weight:700;letter-spacing:0}",

    ".network-line{display:flex;align-items:center;gap:6px;color:#91a6c4;font-size:8px;margin-top:4px}",

    ".network-dot{width:5px;height:5px;border-radius:50%;background:#42e59a}",

    ".network-bars{height:42px;margin-top:19px;display:flex;align-items:flex-end;gap:5px}",

    ".network-bars span{display:block;width:18px;border-radius:4px 4px 2px 2px;background:linear-gradient(to top,rgba(24,119,242,.3),rgba(115,160,255,.8))}",

    ".network-bars span:nth-child(1){height:18px}",

    ".network-bars span:nth-child(2){height:28px}",

    ".network-bars span:nth-child(3){height:21px}",

    ".network-bars span:nth-child(4){height:35px}",

    ".network-bars span:nth-child(5){height:25px}",

    ".network-bars span:nth-child(6){height:39px}",

    ".network-bars span:nth-child(7){height:29px}",

    ".network-bars span:nth-child(8){height:36px}",

    ".network-bars span:nth-child(9){height:42px}",

    ".floating-card-small{right:-5px;bottom:15px;padding:10px 13px;display:flex;align-items:center;gap:9px}",

    ".small-icon{width:30px;height:30px;border-radius:9px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:900}",

    ".floating-card-small strong{display:block;color:#fff;font-size:17px;line-height:1}",

    ".floating-card-small span{display:block;color:#8fa4c3;font-size:7px;margin-top:4px}",


    /* OVERVIEW */

    ".overview-panel{position:relative;background:#fff;border:1px solid #e2e8f0;border-radius:19px;padding:23px;box-shadow:0 9px 30px rgba(16,24,40,.045);margin-bottom:39px;overflow:hidden}",

    ".overview-panel:after{content:'';position:absolute;width:230px;height:230px;border-radius:50%;right:-130px;top:-140px;background:rgba(79,70,229,.035)}",

    ".overview-heading{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:20px}",

    ".light-blue{color:#1877f2!important}",

    ".overview-heading h2{margin:0;font-size:20px;letter-spacing:-.5px}",

    ".overview-heading p{margin:5px 0 0;color:#98a2b3;font-size:10px}",

    ".overview-total{display:flex;align-items:baseline;gap:6px;background:#f7f9fc;border:1px solid #edf0f4;border-radius:11px;padding:9px 12px}",

    ".overview-total span{font-size:8px;color:#98a2b3;font-weight:750}",

    ".overview-total strong{font-size:21px;color:#101828}",

    ".overview-total small{font-size:8px;color:#667085;font-weight:700}",

    ".overview-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:18px}",

    ".overview-stat{display:flex;align-items:center;gap:10px;padding:12px;border-radius:11px;background:#f9fafc;border:1px solid #edf0f4}",

    ".overview-stat-icon{width:35px;height:35px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:900}",

    ".blue-icon{background:#edf5ff;color:#1877f2}",

    ".purple-icon{background:#f1efff;color:#6b5ce7}",

    ".green-icon{background:#ecfdf3;color:#12b76a}",

    ".overview-stat span{display:block;color:#98a2b3;font-size:8px;font-weight:700}",

    ".overview-stat strong{display:block;margin-top:3px;color:#101828;font-size:18px}",

    ".overview-stat .ready-text{color:#12b76a;font-size:14px}",

    ".overview-accounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}",

    ".overview-account{min-width:0;display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid #e8edf3;background:#fff;border-radius:11px;transition:.2s}",

    ".overview-account:hover{border-color:#c6daf6;box-shadow:0 5px 15px rgba(24,119,242,.06);transform:translateY(-1px)}",

    ".overview-account-left{min-width:0;display:flex;align-items:center;gap:9px;flex:1}",

    ".overview-facebook-icon{width:32px;height:32px;flex:0 0 auto;border-radius:9px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900}",

    ".overview-account-info{min-width:0}",

    ".overview-account-name{font-size:10px;font-weight:850;color:#1d2939;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".overview-account-id{font-size:7px;color:#98a2b3;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".overview-account-pages{padding:0 10px;border-left:1px solid #edf0f4;border-right:1px solid #edf0f4;text-align:center;display:flex;flex-direction:column}",

    ".overview-account-pages strong{font-size:15px;line-height:1;color:#101828}",

    ".overview-account-pages span{font-size:7px;color:#98a2b3;margin-top:3px}",

    ".overview-account-status{display:flex;align-items:center;gap:5px;color:#12a866;font-size:7px;font-weight:800;white-space:nowrap}",

    ".status-pulse{width:5px;height:5px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 4px rgba(18,183,106,.08)}",

    ".overview-footer{display:flex;align-items:center;gap:7px;margin-top:13px}",

    ".overview-select-btn,.overview-clear-btn{height:30px;border-radius:7px;padding:0 10px;font-size:8px;font-weight:800}",

    ".overview-select-btn{border:1px solid #cfe0f8;background:#f2f7ff;color:#1769d2}",

    ".overview-clear-btn{border:1px solid #e4e7ec;background:#fff;color:#667085}",


    /* CONTENT HEADING */

    ".content-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:16px}",

    ".section-eyebrow{font-size:8px;color:#1877f2;font-weight:900;letter-spacing:1.3px;margin-bottom:6px}",

    ".content-heading h2{margin:0;font-size:22px;letter-spacing:-.6px}",

    ".content-heading p{margin:5px 0 0;color:#98a2b3;font-size:10px}",

    ".account-limit{display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #e4e8ee;border-radius:9px;padding:8px 11px;color:#667085;font-size:9px;font-weight:800}",

    ".limit-dot{width:5px;height:5px;border-radius:50%;background:#1877f2}",


    /* ACCOUNT CARD */

    ".account-card{background:#fff;border:1px solid #e3e8ef;border-radius:16px;box-shadow:0 7px 25px rgba(16,24,40,.04);margin-bottom:13px;overflow:hidden;transition:.22s}",

    ".account-card:hover{box-shadow:0 12px 34px rgba(16,24,40,.065);border-color:#d6e0ec}",

    ".account-header{padding:18px 19px;display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #edf1f5}",

    ".account-main{display:flex;align-items:center;gap:12px;min-width:0}",

    ".facebook-account-icon{width:44px;height:44px;flex:0 0 auto;border-radius:12px;background:linear-gradient(135deg,#1877f2,#4f8df7);color:#fff;display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:900;box-shadow:0 7px 16px rgba(24,119,242,.16)}",

    ".account-title-wrap{min-width:0}",

    ".account-label{font-size:7px;letter-spacing:1.1px;color:#98a2b3;font-weight:900;margin-bottom:4px}",

    ".account-header h2{margin:0 0 5px;font-size:15px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".facebook-id{display:flex;align-items:center;gap:5px;color:#98a2b3;font-size:8px;white-space:nowrap}",

    ".facebook-id span{font-size:6px;background:#f2f4f7;color:#667085;border-radius:4px;padding:3px 5px;font-weight:900}",

    ".account-header-right{display:flex;align-items:center;gap:13px}",

    ".account-connected-label{display:flex;align-items:center;gap:6px;color:#12a866;font-size:8px;font-weight:850}",

    ".account-page-count{display:flex;align-items:baseline;gap:4px;padding:0 13px;border-left:1px solid #eaecf0;border-right:1px solid #eaecf0}",

    ".account-page-count strong{font-size:19px;color:#101828}",

    ".account-page-count span{font-size:8px;color:#98a2b3;font-weight:700}",

    ".account-actions{display:flex;gap:6px;align-items:center}",

    ".account-actions form{margin:0}",

    ".btn{border:0;border-radius:7px;height:33px;padding:0 10px;display:flex;align-items:center;gap:5px;font-size:9px;font-weight:850;transition:.2s}",

    ".btn-blue{background:#1877f2;color:#fff;box-shadow:0 4px 10px rgba(24,119,242,.13)}",

    ".btn-blue:hover{background:#0f68df;transform:translateY(-1px)}",

    ".btn-light-danger{background:#fff;border:1px solid #efd7d4;color:#d92d20}",

    ".btn-light-danger:hover{background:#fff5f4}",

    ".btn-icon{font-size:12px}",


    /* PAGES */

    ".pages-section{padding:17px 19px 19px}",

    ".pages-toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:11px}",

    ".pages-toolbar-left{min-width:0}",

    ".pages-title-row{display:flex;align-items:center;gap:6px}",

    ".pages-title-dot{width:5px;height:5px;border-radius:50%;background:#1877f2}",

    ".pages-section-title{font-size:10px;font-weight:850;color:#344054}",

    ".pages-section-subtitle{font-size:8px;color:#98a2b3;margin-top:3px;margin-left:11px}",

    ".select-actions{display:flex;gap:5px}",

    ".tool-btn{height:28px;background:#fff;color:#475467;border:1px solid #e4e7ec;border-radius:7px;padding:0 8px;cursor:pointer;font-size:8px;font-weight:800;transition:.2s}",

    ".tool-btn:hover{background:#f8fafc;border-color:#cfd5df}",

    ".tool-btn span{color:#1877f2;margin-right:2px}",

    ".page-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}",

    ".page-row{position:relative;display:flex;align-items:center;gap:9px;min-height:56px;padding:8px 10px;background:#fafbfc;border:1px solid #e9edf2;border-radius:9px;cursor:pointer;transition:.18s}",

    ".page-row:hover{background:#f7faff;border-color:#b9d4f7;transform:translateY(-1px)}",

    ".page-row.selected{background:linear-gradient(100deg,#f1f7ff,#f8faff);border-color:#91bff5;box-shadow:0 0 0 1px rgba(24,119,242,.035)}",

    ".page-checkbox{position:absolute;opacity:0;width:1px;height:1px}",

    ".page-avatar{width:34px;height:34px;flex:0 0 auto;border-radius:9px;background:linear-gradient(135deg,#1877f2,#5b8ff5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:10px;letter-spacing:-.2px}",

    ".page-info{min-width:0;flex:1}",

    ".page-name{font-size:10px;font-weight:850;margin-bottom:4px;color:#1d2939;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".page-meta{font-size:7px;color:#98a2b3;display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden}",

    ".online-dot{width:4px;height:4px;border-radius:50%;background:#12b76a;flex:0 0 auto}",

    ".meta-separator{color:#d0d5dd}",

    ".page-ready{font-size:6px;color:#12a866;font-weight:900;background:#ecfdf3;padding:4px 5px;border-radius:5px}",

    ".page-select-indicator{width:20px;height:20px;border:1.5px solid #d0d5dd;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:.18s}",

    ".checkmark{opacity:0;color:#fff;font-size:11px;font-weight:900;transform:scale(.6);transition:.18s}",

    ".page-row.selected .page-select-indicator{background:#1877f2;border-color:#1877f2}",

    ".page-row.selected .checkmark{opacity:1;transform:scale(1)}",

    ".no-pages{display:flex;align-items:center;gap:11px;background:#f8fafc;border:1px dashed #dfe3e8;border-radius:9px;padding:14px}",

    ".no-pages-icon{width:34px;height:34px;border-radius:9px;background:#eef2f6;color:#98a2b3;display:flex;align-items:center;justify-content:center;font-size:17px}",

    ".no-pages strong{font-size:10px;color:#475467}",

    ".no-pages p{margin:3px 0 0;color:#98a2b3;font-size:8px}",


    /* PUBLISHER */

    ".publisher-card{position:relative;overflow:hidden;background:#fff;border:1px solid #dfe6ef;border-radius:18px;box-shadow:0 12px 35px rgba(16,24,40,.055);margin-top:23px;padding:23px}",

    ".publisher-glow{position:absolute;width:300px;height:300px;border-radius:50%;right:-180px;top:-170px;background:radial-gradient(circle,rgba(24,119,242,.08),transparent 68%);pointer-events:none}",

    ".publisher-top{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:15px}",

    ".publisher-title-area{display:flex;align-items:center;gap:11px}",

    ".composer-icon{width:41px;height:41px;border-radius:11px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800}",

    ".publisher-card h2{margin:0;font-size:17px;letter-spacing:-.3px}",

    ".publisher-card p{margin:4px 0 0;color:#667085;font-size:9px}",

    ".selection-badge{display:flex;align-items:center;gap:6px;background:#edf5ff;color:#1769d2;border:1px solid #d8e8fb;border-radius:20px;padding:7px 10px;font-size:8px;font-weight:850}",

    ".selection-dot{width:5px;height:5px;border-radius:50%;background:#1877f2}",

    ".publisher-divider{height:1px;background:#edf1f5;margin:19px 0}",

    ".field{margin-bottom:17px}",

    ".field-label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}",

    ".field label{display:block;font-size:9px;color:#344054;font-weight:850;margin-bottom:7px}",

    ".field-label-row label{margin:0}",

    "#char-count{font-size:7px;color:#98a2b3}",

    ".textarea-wrap{border:1px solid #dfe4ea;border-radius:10px;overflow:hidden;transition:.2s}",

    ".textarea-wrap:focus-within{border-color:#91bff5;box-shadow:0 0 0 3px rgba(24,119,242,.07)}",

    "textarea{width:100%;resize:vertical;border:0;padding:13px 14px 9px;min-height:135px;font-size:11px;line-height:1.6;color:#101828;outline:none}",

    "textarea::placeholder{color:#a4acb8}",

    ".textarea-footer{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-top:1px solid #f0f2f5;background:#fafbfc;color:#98a2b3;font-size:7px}",

    ".upload-box{min-height:68px!important;display:flex!important;align-items:center!important;gap:11px!important;border:1px dashed #b9c3d0!important;border-radius:10px!important;padding:10px 12px!important;background:#fbfcfe!important;cursor:pointer!important;transition:.2s!important}",

    ".upload-box:hover{background:#f5f9ff!important;border-color:#1877f2!important}",

    ".upload-icon{width:37px;height:37px;flex:0 0 auto;border-radius:9px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:900}",

    ".upload-content{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}",

    ".upload-content strong{font-size:9px;color:#344054}",

    ".upload-content span{font-size:7px;color:#98a2b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    ".upload-action{border:1px solid #dfe3e8;background:#fff;color:#475467;border-radius:6px;padding:6px 9px;font-size:7px;font-weight:850}",

    ".upload-box input{display:none}",

    ".upload-hint{font-size:7px;color:#98a2b3;margin-top:6px}",

    ".publish-footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding-top:2px}",

    ".publish-info{display:flex;align-items:center;gap:8px}",

    ".publish-info strong{display:block;color:#344054;font-size:8px}",

    ".publish-info span{display:block;color:#98a2b3;font-size:7px;margin-top:3px}",

    ".publish-check{width:25px;height:25px;border-radius:8px;background:#ecfdf3;color:#12b76a;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900}",

    ".publish-btn{height:42px;border:0;background:linear-gradient(135deg,#1877f2,#4f46e5);color:#fff;padding:0 15px;border-radius:9px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:9px;font-weight:900;cursor:pointer;box-shadow:0 7px 19px rgba(58,90,220,.2);transition:.2s}",

    ".publish-btn:hover{transform:translateY(-1px);box-shadow:0 11px 25px rgba(58,90,220,.27)}",

    ".publish-btn:disabled{opacity:.7;cursor:wait;transform:none}",

    ".publish-btn-icon{font-size:11px}",


    /* EMPTY */

    ".empty-state{background:#fff;border:1px solid #e3e8ef;border-radius:16px;padding:48px 25px;text-align:center;box-shadow:0 7px 25px rgba(16,24,40,.04)}",

    ".empty-illustration{display:flex;justify-content:center;margin-bottom:12px}",

    ".empty-illustration-circle{width:58px;height:58px;border-radius:17px;background:linear-gradient(135deg,#1877f2,#5b8ff5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:31px;font-weight:900;box-shadow:0 10px 22px rgba(24,119,242,.2)}",

    ".empty-eyebrow{color:#1877f2;font-size:7px;font-weight:900;letter-spacing:1.2px;margin-bottom:5px}",

    ".empty-state h3{margin:0;font-size:16px}",

    ".empty-state p{max-width:450px;margin:7px auto 18px;color:#667085;font-size:10px;line-height:1.6}",

    ".empty-connect-btn{display:inline-flex;align-items:center;gap:6px;background:#1877f2;color:#fff;text-decoration:none;padding:10px 13px;border-radius:8px;font-size:9px;font-weight:850}",


    /* FOOTER */

    ".dashboard-footer{display:flex;align-items:center;justify-content:center;gap:7px;color:#98a2b3;font-size:7px;padding-top:26px}",

    ".footer-brand{display:flex;align-items:center;gap:5px}",

    ".footer-logo{width:17px;height:17px;border-radius:5px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900}",

    ".footer-separator{color:#d0d5dd}",


    /* RESULTS */

    ".results-page{min-height:calc(100vh - 74px);padding:45px 20px;background:#f4f7fb}",

    ".results-card{max-width:850px;margin:0 auto;background:#fff;border:1px solid #e2e7ee;border-radius:17px;padding:27px;box-shadow:0 12px 38px rgba(16,24,40,.07)}",

    ".results-top{display:flex;align-items:center;gap:12px}",

    ".results-icon{width:51px;height:51px;border-radius:14px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:900}",

    ".results-card h2{margin:0;font-size:21px}",

    ".result-summary{margin:9px 0 20px;color:#667085;font-size:10px}",

    ".results-list{display:flex;flex-direction:column;gap:7px}",

    ".result-row{border:1px solid #e4e7ec;border-radius:9px;padding:11px;display:grid;grid-template-columns:1fr auto;gap:6px 15px}",

    ".result-success{background:#f6fffa;border-color:#ccebd9}",

    ".result-failed{background:#fff8f7;border-color:#f0d0cc}",

    ".result-main{display:flex;align-items:center;gap:8px}",

    ".result-avatar{width:32px;height:32px;border-radius:8px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900}",

    ".result-row strong{font-size:10px}",

    ".result-page-id{margin-top:3px;color:#98a2b3;font-size:7px}",

    ".result-status{font-size:8px;font-weight:900;align-self:center}",

    ".result-success .result-status{color:#12b76a}",

    ".result-failed .result-status{color:#d92d20}",

    ".result-extra{grid-column:1/-1}",

    ".result-error{color:#667085;font-size:8px;word-break:break-word}",

    ".back-btn{display:inline-flex;align-items:center;margin-top:18px;padding:9px 12px;background:#1877f2;color:#fff;text-decoration:none;border-radius:8px;font-size:9px;font-weight:850}",


    /* ERROR */

    ".error-page-wrap{min-height:100vh;padding:50px 20px;background:#f4f7fb}",

    ".error-box{max-width:900px;margin:0 auto;background:#fff;border:1px solid #eadbd9;border-radius:17px;padding:28px;box-shadow:0 10px 35px rgba(16,24,40,.06)}",

    ".error-icon{width:44px;height:44px;border-radius:12px;background:#fff0ee;color:#d92d20;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;margin-bottom:12px}",

    ".error-box h2{margin:0 0 6px}",

    ".error-lead{color:#667085;font-size:11px}",

    "pre{background:#f8f9fb;border:1px solid #eaecf0;padding:13px;border-radius:9px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:9px;color:#475467}",


    /* LOGIN */

    ".login-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:25px;background:linear-gradient(135deg,#06132c,#0b2450 55%,#172e70);position:relative;overflow:hidden}",

    ".login-screen:before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:30px 30px}",

    ".login-glow{position:absolute;border-radius:50%;filter:blur(2px)}",

    ".login-glow-one{width:500px;height:500px;left:-300px;top:-280px;background:rgba(24,119,242,.18)}",

    ".login-glow-two{width:450px;height:450px;right:-280px;bottom:-260px;background:rgba(124,92,255,.16)}",

    ".login-card{position:relative;width:100%;max-width:410px;background:rgba(255,255,255,.97);border:1px solid rgba(255,255,255,.4);border-radius:20px;box-shadow:0 30px 90px rgba(0,0,0,.25);padding:29px;z-index:2}",

    ".login-brand{display:flex;align-items:center;gap:10px;margin-bottom:28px}",

    ".login-logo{width:39px;height:39px;border-radius:11px;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;box-shadow:0 8px 18px rgba(24,119,242,.2)}",

    ".login-brand-name{font-size:13px;font-weight:900;color:#101828}",

    ".login-brand-sub{font-size:7px;color:#98a2b3;text-transform:uppercase;letter-spacing:.8px;margin-top:3px}",

    ".login-title-area{text-align:center}",

    ".login-lock{width:52px;height:52px;margin:0 auto 11px;border-radius:16px;background:#edf5ff;color:#1877f2;display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:900}",

    ".login-eyebrow{font-size:7px;letter-spacing:1.3px;color:#1877f2;font-weight:900;margin-bottom:5px}",

    ".login-card h1{margin:0 0 6px;font-size:25px;letter-spacing:-.7px}",

    ".login-card p{margin:0;color:#667085;font-size:10px;line-height:1.6}",

    ".login-error{display:flex;align-items:center;gap:7px;background:#fff5f4;border:1px solid #f3d0cc;color:#d92d20;padding:9px 10px;border-radius:8px;margin:17px 0 0;font-size:8px}",

    ".login-error-icon{width:16px;height:16px;border-radius:50%;background:#d92d20;color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900}",

    ".login-form{margin-top:20px}",

    ".login-field label{display:block;font-size:8px;font-weight:850;color:#344054;margin-bottom:6px}",

    ".password-wrap{position:relative}",

    ".password-symbol{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:6px;color:#98a2b3}",

    ".login-card input[type=password]{width:100%;height:43px;padding:0 12px 0 28px;border:1px solid #dfe3e8;border-radius:8px;font-size:10px;outline:none;background:#fff;transition:.2s}",

    ".login-card input[type=password]:focus{border-color:#91bff5;box-shadow:0 0 0 3px rgba(24,119,242,.07)}",

    ".login-btn{width:100%;height:43px;border:0;background:linear-gradient(135deg,#1877f2,#4f46e5);color:#fff;border-radius:8px;font-size:10px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:11px;box-shadow:0 8px 19px rgba(52,86,211,.2);transition:.2s}",

    ".login-btn:hover{transform:translateY(-1px);box-shadow:0 11px 24px rgba(52,86,211,.28)}",

    ".login-arrow{font-size:15px}",

    ".login-secure{display:flex;align-items:center;justify-content:center;gap:6px;color:#98a2b3;font-size:7px;margin-top:19px;padding-top:16px;border-top:1px solid #eef1f5}",

    ".secure-pulse{width:5px;height:5px;border-radius:50%;background:#12b76a}",


    /* RESPONSIVE */

    "@media(max-width:1080px){.hero-right{right:15px;opacity:.42}.hero-left{max-width:650px}.dashboard-hero{padding-left:38px}}",

    "@media(max-width:820px){.topbar{height:auto;min-height:68px}.topbar-inner{padding:11px 15px}.top-status{display:none}.container{padding:18px 14px 50px}.dashboard-hero{min-height:390px;padding:32px 24px;border-radius:19px}.dashboard-hero h1{font-size:32px}.hero-right{display:none}.overview-stats{grid-template-columns:1fr}.overview-accounts{grid-template-columns:1fr}.content-heading{align-items:flex-start;flex-direction:column}.account-header{align-items:flex-start;flex-direction:column}.account-header-right{width:100%;justify-content:space-between}.account-page-count{display:none}.page-list{grid-template-columns:1fr}.publisher-card{padding:19px}.publish-footer{align-items:stretch;flex-direction:column}.publish-btn{width:100%}}",

    "@media(max-width:520px){.brand-text{display:none}.connect-btn span:last-child{display:none}.connect-btn{width:38px;padding:0}.logout-btn span:last-child{display:none}.logout-btn{width:38px;padding:0;justify-content:center}.dashboard-hero{padding:28px 20px;min-height:395px}.dashboard-hero h1{font-size:27px}.dashboard-hero p{font-size:11px}.hero-buttons{align-items:flex-start;flex-direction:column}.hero-primary,.hero-secondary{width:100%;justify-content:center}.overview-panel{padding:17px}.overview-heading{align-items:flex-start}.overview-total{display:none}.overview-account{gap:7px}.overview-account-status{display:none}.account-actions{width:100%;display:grid;grid-template-columns:1fr 1fr}.account-actions form{width:100%}.account-actions .btn{width:100%;justify-content:center}.pages-toolbar{align-items:flex-start;flex-direction:column}.select-actions{width:100%}.tool-btn{flex:1}.upload-box{flex-wrap:wrap}.upload-action{margin-left:auto}.dashboard-footer{flex-wrap:wrap}.results-card{padding:21px}}"

  ].join("");

  return new Response(
    "<!DOCTYPE html>" +
    '<html lang="en">' +

      "<head>" +

        '<meta charset="UTF-8">' +

        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +

        '<meta name="theme-color" content="#07152f">' +

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
