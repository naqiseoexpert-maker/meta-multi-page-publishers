const APP_NAME = "Meta Multi Page Publisher";

export default {
  async fetch(request, env) {
    try {
      await ensureDatabaseSchema(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      // ---------------------------------------------------------
      // PUBLIC LOGIN
      // ---------------------------------------------------------
      if (request.method === "GET" && path === "/login") {
        return showLoginPage("");
      }

      if (request.method === "POST" && path === "/login") {
        return handleLogin(request, env);
      }

      // ---------------------------------------------------------
      // AUTHENTICATION
      // ---------------------------------------------------------
      const auth = await getAuthenticatedSession(request, env);

      if (!auth) {
        return Response.redirect(url.origin + "/login", 302);
      }

      // ---------------------------------------------------------
      // DASHBOARD
      // ---------------------------------------------------------
      if (request.method === "GET" && path === "/") {
        const allowed = await consumeDashboardTicket(
          env.DB,
          auth.sessionId
        );

        if (!allowed) {
          await deleteSession(env.DB, auth.sessionId);

          return new Response(null, {
            status: 302,
            headers: {
              Location: url.origin + "/login",
              "Set-Cookie": clearAuthCookie(),
              "Cache-Control": "no-store"
            }
          });
        }

        return showDashboard(env);
      }

      // ---------------------------------------------------------
      // META OAUTH
      // ---------------------------------------------------------
      if (request.method === "GET" && path === "/auth/meta") {
        return startMetaLogin(request, env, auth.sessionId);
      }

      if (
        request.method === "GET" &&
        path === "/auth/meta/callback"
      ) {
        return metaCallback(request, env, auth.sessionId);
      }

      // ---------------------------------------------------------
      // SYNC
      // ---------------------------------------------------------
      if (request.method === "POST" && path === "/sync") {
        const response = await syncPages(request, env);

        await allowNextDashboardLoad(
          env.DB,
          auth.sessionId
        );

        return response;
      }

      // ---------------------------------------------------------
      // REMOVE ACCOUNT
      // ---------------------------------------------------------
      if (
        request.method === "POST" &&
        path === "/remove-account"
      ) {
        const response = await removeAccount(
          request,
          env
        );

        await allowNextDashboardLoad(
          env.DB,
          auth.sessionId
        );

        return response;
      }

      // ---------------------------------------------------------
      // PUBLISH - START NEW RUN
      // ---------------------------------------------------------
      if (
        request.method === "POST" &&
        path === "/publish"
      ) {
        return startPublishRun(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // PUBLISH - PROCESS BATCH
      // ---------------------------------------------------------
      if (
        request.method === "POST" &&
        path === "/publish-batch"
      ) {
        return processPublishBatch(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // PUBLISH - RESULTS
      // ---------------------------------------------------------
      if (
        request.method === "GET" &&
        path === "/publish-results"
      ) {
        return showPublishResults(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // LOGOUT
      // ---------------------------------------------------------
      if (
        (request.method === "POST" ||
          request.method === "GET") &&
        path === "/logout"
      ) {
        await deleteSession(
          env.DB,
          auth.sessionId
        );

        return handleLogout();
      }

      return new Response("Not Found", {
        status: 404
      });
    } catch (error) {
      console.error(error);

      // API endpoints must always return JSON.
      // Otherwise the browser may receive the HTML error page and
      // fail with: Unexpected token '<' / invalid JSON.
      const url = new URL(request.url);
      const path = url.pathname;

      if (
        request.method === "POST" &&
        (path === "/publish" ||
          path === "/publish-batch")
      ) {
        return jsonResponse(
          {
            error:
              error &&
              error.message
                ? error.message
                : String(error)
          },
          500
        );
      }

      return page(
        "Error",
        `
        <div class="error-screen">
          <div class="error-box">
            <div class="error-icon">!</div>
            <div class="eyebrow">SYSTEM ERROR</div>

            <h2>Something went wrong</h2>

            <p class="error-intro">
              The dashboard could not complete this request.
            </p>

            <pre>${escapeHtml(
              error &&
              (error.stack || error.message)
                ? error.stack || error.message
                : String(error)
            )}</pre>

            <a class="back-btn" href="/login">
              Return to Login
            </a>
          </div>
        </div>
        `
      );
    }
  }
};

// =============================================================
// AUTHENTICATION
// =============================================================

async function getAuthenticatedSession(request, env) {
  const password = String(
    env.PUBLISHER_PASSWORD || ""
  ).trim();

  if (!password) {
    throw new Error(
      "PUBLISHER_PASSWORD secret is missing. Add it in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  const cookies = parseCookies(
    request.headers.get("Cookie") || ""
  );

  const sessionId = cookies.mp_session;

  if (!sessionId) {
    return null;
  }

  const session = await env.DB.prepare(
    "SELECT id, created_at, dashboard_ticket " +
      "FROM auth_sessions WHERE id = ?"
  )
    .bind(sessionId)
    .first();

  if (!session) {
    return null;
  }

  const created = Date.parse(
    String(session.created_at || "")
  );

  if (
    Number.isFinite(created) &&
    Date.now() - created >
      24 * 60 * 60 * 1000
  ) {
    await deleteSession(
      env.DB,
      sessionId
    );

    return null;
  }

  return {
    sessionId,
    dashboardTicket: Number(
      session.dashboard_ticket || 0
    )
  };
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

  const sessionId =
    crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO auth_sessions " +
      "(id, created_at, dashboard_ticket) " +
      "VALUES (?, datetime('now'), 1)"
  )
    .bind(sessionId)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "mp_session=" +
        encodeURIComponent(sessionId) +
        "; Path=/; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store"
    }
  });
}

async function consumeDashboardTicket(
  db,
  sessionId
) {
  const result = await db
    .prepare(
      "UPDATE auth_sessions " +
        "SET dashboard_ticket = 0 " +
        "WHERE id = ? AND dashboard_ticket = 1"
    )
    .bind(sessionId)
    .run();

  return Number(
    result.meta &&
      result.meta.changes
      ? result.meta.changes
      : 0
  ) > 0;
}

async function allowNextDashboardLoad(
  db,
  sessionId
) {
  await db
    .prepare(
      "UPDATE auth_sessions " +
        "SET dashboard_ticket = 1 " +
        "WHERE id = ?"
    )
    .bind(sessionId)
    .run();
}

async function deleteSession(
  db,
  sessionId
) {
  if (!sessionId) {
    return;
  }

  await db
    .prepare(
      "DELETE FROM auth_sessions WHERE id = ?"
    )
    .bind(sessionId)
    .run();
}

function clearAuthCookie() {
  return (
    "mp_session=; Path=/; Max-Age=0; " +
    "HttpOnly; Secure; SameSite=Lax"
  );
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": clearAuthCookie(),
      "Cache-Control": "no-store"
    }
  });
}

function parseCookies(header) {
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name = part
      .slice(0, index)
      .trim();

    const value = part
      .slice(index + 1)
      .trim();

    if (name) {
      cookies[name] =
        decodeURIComponent(value);
    }
  }

  return cookies;
}

// =============================================================
// LOGIN PAGE
// =============================================================

function showLoginPage(errorMessage) {
  const errorHtml = errorMessage
    ? `
      <div class="login-error">
        <span class="login-error-icon">!</span>
        <span>${escapeHtml(
          errorMessage
        )}</span>
      </div>
    `
    : "";

  return page(
    "Password Required",
    `
    <div class="login-page">
      <div class="login-background-orb orb-one"></div>
      <div class="login-background-orb orb-two"></div>

      <div class="login-card">

        <div class="login-brand">
          <div class="brand-mark">
            <span>f</span>
          </div>

          <div>
            <div class="brand-name">
              NAQI SHAH
            </div>

            <div class="brand-mini">
              COMMAND CENTER
            </div>
          </div>
        </div>

        <div class="login-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 10V8a5 5 0 0 0-10 0v2"/>
            <rect
              x="4"
              y="10"
              width="16"
              height="11"
              rx="2"
            />
            <path d="M12 14v3"/>
          </svg>
        </div>

        <div class="eyebrow">
          SECURE ACCESS
        </div>

        <h1>Password Required</h1>

        <p class="login-description">
          Enter your dashboard password to access your
          Facebook publishing command center.
        </p>

        ${errorHtml}

        <form
          method="POST"
          action="/login"
          class="login-form"
        >
          <label for="password">
            Dashboard Password
          </label>

          <div class="password-wrap">
            <input
              id="password"
              type="password"
              name="password"
              placeholder="Enter your password"
              autocomplete="current-password"
              required
              autofocus
            />

            <button
              type="button"
              class="show-password"
              onclick="togglePassword()"
              aria-label="Show password"
            >
              <svg
                id="eyeIcon"
                viewBox="0 0 24 24"
              >
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
                <circle
                  cx="12"
                  cy="12"
                  r="2.5"
                />
              </svg>
            </button>
          </div>

          <button
            type="submit"
            class="login-submit"
          >
            <span>Enter Dashboard</span>

            <svg viewBox="0 0 24 24">
              <path d="M5 12h14"/>
              <path d="m13 6 6 6-6 6"/>
            </svg>
          </button>
        </form>

        <div class="login-security">
          <span class="security-dot"></span>
          Protected dashboard session
        </div>

      </div>
    </div>

    <script>
      function togglePassword() {
        const input =
          document.getElementById("password");

        const icon =
          document.getElementById("eyeIcon");

        if (input.type === "password") {
          input.type = "text";

          icon.innerHTML =
            '<path d="M3 3l18 18"/>' +
            '<path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>' +
            '<path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 3.8"/>' +
            '<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 3.1-.5"/>';
        } else {
          input.type = "password";

          icon.innerHTML =
            '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>' +
            '<circle cx="12" cy="12" r="2.5"/>';
        }
      }
    </script>
    `
  );
}

// =============================================================
// DATABASE
// =============================================================

async function ensureDatabaseSchema(db) {
  if (!db) {
    throw new Error(
      "D1 database binding DB is missing. Check your Cloudflare Worker D1 binding name."
    );
  }

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS accounts (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "facebook_user_id TEXT NOT NULL UNIQUE, " +
        "account_name TEXT, " +
        "access_token TEXT NOT NULL, " +
        "created_at TEXT DEFAULT (datetime('now'))" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS pages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "facebook_page_id TEXT NOT NULL UNIQUE, " +
        "page_name TEXT, " +
        "access_token TEXT NOT NULL, " +
        "account_id INTEGER NOT NULL, " +
        "created_at TEXT DEFAULT (datetime('now'))" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_pages_account_id " +
        "ON pages(account_id)"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS auth_sessions (" +
        "id TEXT PRIMARY KEY, " +
        "created_at TEXT NOT NULL, " +
        "dashboard_ticket INTEGER NOT NULL DEFAULT 0" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS publish_runs (" +
        "id TEXT PRIMARY KEY, " +
        "session_id TEXT NOT NULL, " +
        "message TEXT, " +
        "media_type TEXT, " +
        "media_name TEXT, " +
        "created_at TEXT NOT NULL, " +
        "completed_at TEXT, " +
        "status TEXT NOT NULL DEFAULT 'processing'" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS publish_run_pages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "run_id TEXT NOT NULL, " +
        "page_db_id INTEGER NOT NULL, " +
        "facebook_page_id TEXT NOT NULL, " +
        "page_name TEXT, " +
        "status TEXT NOT NULL DEFAULT 'pending', " +
        "post_id TEXT, " +
        "error TEXT, " +
        "created_at TEXT NOT NULL, " +
        "completed_at TEXT, " +
        "UNIQUE(run_id, page_db_id)" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_publish_run_pages_run_id " +
        "ON publish_run_pages(run_id)"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_publish_run_pages_status " +
        "ON publish_run_pages(run_id, status)"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM auth_sessions " +
        "WHERE created_at < datetime('now', '-1 day')"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM publish_runs " +
        "WHERE created_at < datetime('now', '-2 day')"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM publish_run_pages " +
        "WHERE run_id NOT IN " +
        "(SELECT id FROM publish_runs)"
    )
    .run();
}

// =============================================================
// META CONFIG
// =============================================================

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

  if (missing.length) {
    throw new Error(
      "Meta configuration is missing: " +
        missing.join(", ") +
        ". Make sure these exact names exist in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  if (!graphVersion.startsWith("v")) {
    graphVersion = "v" + graphVersion;
  }

  return {
    appId,
    appSecret,
    graphVersion
  };
}

// =============================================================
// DASHBOARD
// =============================================================

async function showDashboard(env) {
  const accountsResult =
    await env.DB.prepare(
      "SELECT id, facebook_user_id, account_name, created_at " +
        "FROM accounts ORDER BY id ASC"
    ).all();

  const accounts =
    accountsResult.results || [];

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, account_id " +
        "FROM pages " +
        "ORDER BY account_id ASC, " +
        "page_name COLLATE NOCASE ASC"
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

  const totalAccounts =
    accounts.length;

  const totalPages =
    pages.length;

  let accountHtml = "";

  if (!accounts.length) {
    accountHtml = `
      <section class="empty-state">

        <div class="empty-icon">
          <svg viewBox="0 0 24 24">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M19 8v6"/>
            <path d="M22 11h-6"/>
          </svg>
        </div>

        <div class="eyebrow">
          GET STARTED
        </div>

        <h3>
          No Facebook account connected
        </h3>

        <p>
          Connect your Facebook account to bring your Pages
          into the publishing command center.
        </p>

        <a class="primary-btn" href="/auth/meta">
          <span class="fb-symbol">f</span>
          Connect Facebook Account
        </a>

      </section>
    `;
  } else {
    for (const account of accounts) {
      const accountPages =
        groupedPages[account.id] || [];

      let pageHtml = "";

      if (accountPages.length) {
        pageHtml = `
          <div class="page-toolbar">

            <div>
              <div class="toolbar-title">
                Connected Pages
              </div>

              <div class="toolbar-subtitle">
                Select the Pages you want to publish to
              </div>
            </div>

            <div class="toolbar-actions">
              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(
                  account.id
                )}, true)"
              >
                Select all
              </button>

              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(
                  account.id
                )}, false)"
              >
                Clear
              </button>
            </div>

          </div>

          <div class="page-list">
        `;

        for (const p of accountPages) {
          const initial =
            getInitials(
              p.page_name || "Page"
            );

          pageHtml += `
            <label class="page-row">

              <input
                class="page-checkbox account-${Number(
                  account.id
                )}"
                type="checkbox"
                name="page_ids"
                value="${escapeHtml(p.id)}"
                form="publish-form"
              />

              <span class="custom-check">
                <svg viewBox="0 0 24 24">
                  <path d="m5 12 4 4L19 6"/>
                </svg>
              </span>

              <span class="page-avatar">
                ${escapeHtml(initial)}
              </span>

              <span class="page-info">

                <span class="page-name">
                  ${escapeHtml(
                    p.page_name ||
                      "Unnamed Page"
                  )}
                </span>

                <span class="page-id">
                  ID:
                  ${escapeHtml(
                    p.facebook_page_id
                  )}
                </span>

              </span>

              <span class="page-ready">
                <span class="ready-dot"></span>
                Ready
              </span>

            </label>
          `;
        }

        pageHtml += `</div>`;
      } else {
        pageHtml = `
          <div class="no-pages">

            <div class="no-pages-icon">
              !
            </div>

            <div>
              <strong>
                No Pages found
              </strong>

              <p>
                Click <b>Sync Pages</b> to refresh
                this Facebook account.
              </p>
            </div>

          </div>
        `;
      }

      const accountInitials =
        getInitials(
          account.account_name ||
            "Facebook Account"
        );

      accountHtml += `
        <section class="account-card">

          <div class="account-top">

            <div class="account-identity">

              <div class="account-avatar">
                ${escapeHtml(
                  accountInitials
                )}
              </div>

              <div class="account-details">

                <div class="account-name-line">

                  <h2>
                    ${escapeHtml(
                      account.account_name ||
                        "Facebook Account"
                    )}
                  </h2>

                  <span class="connected-badge">
                    <span></span>
                    Connected
                  </span>

                </div>

                <div class="facebook-id">
                  Facebook ID:
                  <code>
                    ${escapeHtml(
                      account.facebook_user_id
                    )}
                  </code>
                </div>

                <div class="account-meta">

                  <span>
                    <strong>
                      ${accountPages.length}
                    </strong>
                    Pages
                  </span>

                </div>

              </div>

            </div>

            <div class="account-actions">

              <form
                method="POST"
                action="/sync"
                class="inline-form"
                onsubmit="return handleSync(this)"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtml(account.id)}"
                />

                <button
                  type="submit"
                  class="secondary-btn"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M20 11a8.1 8.1 0 0 0-15.5-2"/>
                    <path d="M4 5v4h4"/>
                    <path d="M4 13a8.1 8.1 0 0 0 15.5 2"/>
                    <path d="M20 19v-4h-4"/>
                  </svg>
                  Sync Pages
                </button>
              </form>

              <form
                method="POST"
                action="/remove-account"
                class="inline-form"
                onsubmit="return confirmRemoveAccount()"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtml(account.id)}"
                />

                <button
                  type="submit"
                  class="danger-btn"
                >
                  Remove
                </button>
              </form>

            </div>

          </div>

          ${pageHtml}

        </section>
      `;
    }
  }

  return page(
    APP_NAME,
    `
    <div class="dashboard-shell">

      <header class="topbar">

        <div class="topbar-left">

          <div class="top-brand-mark">
            <span>f</span>
          </div>

          <div class="top-brand-text">

            <div class="top-brand-name">
              NAQI SHAH
            </div>

            <div class="top-brand-sub">
              META MULTI PAGE PUBLISHER
            </div>

          </div>

        </div>

        <div class="topbar-right">

          <div class="status-pill">
            <span class="status-dot"></span>
            SYSTEM ONLINE
          </div>

          <a
            href="/logout"
            class="logout-btn"
          >
            Logout
          </a>

        </div>

      </header>

      <main class="dashboard-main">

        <section class="hero-section">

          <div class="hero-copy">

            <div class="eyebrow">
              PUBLISHING COMMAND CENTER
            </div>

            <h1>
              Manage all your
              <span>Facebook Pages</span>
              in one place.
            </h1>

            <p>
              Connect your Facebook accounts, select the Pages
              you need, and publish content across multiple
              Pages from a single dashboard.
            </p>

          </div>

          <div class="hero-stats">

            <div class="stat-card">
              <div class="stat-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M19 8v6"/>
                  <path d="M22 11h-6"/>
                </svg>
              </div>

              <div class="stat-value">
                ${totalAccounts}
              </div>

              <div class="stat-label">
                Accounts
              </div>
            </div>

            <div class="stat-card">
              <div class="stat-icon">
                <svg viewBox="0 0 24 24">
                  <rect
                    x="3"
                    y="4"
                    width="18"
                    height="16"
                    rx="3"
                  />
                  <path d="M7 8h10"/>
                  <path d="M7 12h10"/>
                  <path d="M7 16h6"/>
                </svg>
              </div>

              <div class="stat-value">
                ${totalPages}
              </div>

              <div class="stat-label">
                Pages
              </div>
            </div>

            <div class="stat-card">
              <div class="stat-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M12 3v18"/>
                  <path d="M3 12h18"/>
                  <path d="m5 5 14 14"/>
                  <path d="m19 5-14 14"/>
                </svg>
              </div>

              <div class="stat-value">
                100+
              </div>

              <div class="stat-label">
                Publishing Capacity
              </div>
            </div>

          </div>

        </section>

        <section class="connect-section">

          <div class="section-heading">

            <div>
              <div class="eyebrow">
                FACEBOOK CONNECTIONS
              </div>

              <h2>
                Connected Accounts
              </h2>

              <p>
                Manage your Facebook accounts and their Pages.
              </p>
            </div>

            <a
              href="/auth/meta"
              class="primary-btn"
            >
              <span class="fb-symbol">f</span>
              Connect Facebook
            </a>

          </div>

          <div class="accounts-list">
            ${accountHtml}
          </div>

        </section>

        <section class="publisher-section">

          <div class="publisher-heading">

            <div>
              <div class="eyebrow">
                CONTENT PUBLISHER
              </div>

              <h2>
                Create a New Post
              </h2>

              <p>
                Select one or more Pages and publish text,
                images, or videos.
              </p>
            </div>

            <div class="batch-info">
              <span class="batch-dot"></span>
              Automatic batch publishing enabled
            </div>

          </div>

          <form
            id="publish-form"
            class="publisher-card"
            onsubmit="return handlePublish(event)"
          >

            <div class="composer">

              <label
                for="message"
                class="field-label"
              >
                Post Message
              </label>

              <textarea
                id="message"
                name="message"
                rows="7"
                placeholder="Write your Facebook post here..."
              ></textarea>

              <div class="composer-footer">
                <span>
                  You can publish text-only posts or attach
                  an image/video below.
                </span>

                <span id="char-count">
                  0 characters
                </span>
              </div>

            </div>

            <div class="media-area">

              <label
                for="media"
                class="field-label"
              >
                Media
                <span class="optional">
                  Optional
                </span>
              </label>

              <label
                for="media"
                class="media-dropzone"
                id="media-dropzone"
              >

                <input
                  id="media"
                  name="media"
                  type="file"
                  accept="image/*,video/*"
                  onchange="handleMediaChange(this)"
                />

                <div class="media-icon">
                  <svg viewBox="0 0 24 24">
                    <rect
                      x="3"
                      y="3"
                      width="18"
                      height="18"
                      rx="3"
                    />
                    <circle
                      cx="8.5"
                      cy="8.5"
                      r="1.5"
                    />
                    <path
                      d="m21 15-5-5L5 21"
                    />
                  </svg>
                </div>

                <div class="media-title">
                  Choose an image or video
                </div>

                <div class="media-subtitle">
                  JPG, PNG, WEBP, MP4 and supported media
                </div>

              </label>

              <div
                id="media-selected"
                class="media-selected hidden"
              >
                <span
                  id="media-name"
                ></span>

                <button
                  type="button"
                  onclick="clearMedia()"
                >
                  Remove
                </button>
              </div>

            </div>

            <div class="publisher-footer">

              <div class="selection-summary">
                <span class="selection-icon">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 6h16"/>
                    <path d="M4 12h16"/>
                    <path d="M4 18h10"/>
                  </svg>
                </span>

                <span>
                  <strong id="selected-count">
                    0
                  </strong>
                  Pages selected
                </span>
              </div>

              <button
                type="submit"
                class="publish-btn"
                id="publish-btn"
              >
                <span>
                  Publish to Selected Pages
                </span>

                <svg viewBox="0 0 24 24">
                  <path d="M5 12h14"/>
                  <path d="m13 6 6 6-6 6"/>
                </svg>
              </button>

            </div>

          </form>

        </section>

        <section
          id="publish-progress-section"
          class="progress-section hidden"
        >

          <div class="progress-card">

            <div class="progress-top">

              <div>
                <div class="eyebrow">
                  PUBLISHING
                </div>

                <h2>
                  Publishing your post...
                </h2>

                <p id="progress-message">
                  Preparing selected Pages.
                </p>
              </div>

              <div
                id="progress-percent"
                class="progress-percent"
              >
                0%
              </div>

            </div>

            <div class="progress-track">
              <div
                id="progress-bar"
                class="progress-bar"
                style="width:0%"
              ></div>
            </div>

            <div class="progress-meta">

              <span id="progress-count">
                0 / 0 Pages
              </span>

              <span id="progress-status">
                Starting...
              </span>

            </div>

          </div>

        </section>

        <section
          id="publish-results-section"
          class="results-section hidden"
        >

          <div class="results-card">

            <div class="results-header">

              <div>
                <div class="eyebrow">
                  PUBLISH RESULTS
                </div>

                <h2>
                  Publishing Complete
                </h2>
              </div>

              <div
                id="results-summary"
                class="results-summary"
              ></div>

            </div>

            <div
              id="results-list"
              class="results-list"
            ></div>

          </div>

        </section>

      </main>

      <footer class="dashboard-footer">
        <div>
          ${escapeHtml(APP_NAME)}
        </div>

        <div>
          NAQI SHAH
        </div>
      </footer>

    </div>

    <script>
      const PUBLISH_BATCH_SIZE = 15;

      function sleep(ms) {
        return new Promise(function(resolve) {
          setTimeout(resolve, ms);
        });
      }

      // Always read API responses safely. If the Worker/Cloudflare
      // returns HTML instead of JSON, show a useful error instead of
      // throwing an unhelpful JSON parsing error.
      async function readApiResponse(response) {
        const text = await response.text();
        let data = null;

        try {
          data = text
            ? JSON.parse(text)
            : null;
        } catch (parseError) {
          const cleaned = text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          throw new Error(
            cleaned ||
            ("Server returned HTTP " +
              response.status)
          );
        }

        if (!response.ok) {
          throw new Error(
            data && data.error
              ? String(data.error)
              : ("Server returned HTTP " +
                  response.status)
          );
        }

        return data;
      }

      function updateSelectedCount() {
        const checked =
          document.querySelectorAll(
            'input[name="page_ids"]:checked'
          );

        const count =
          document.getElementById(
            "selected-count"
          );

        if (count) {
          count.textContent =
            checked.length;
        }
      }

      function selectAccountPages(
        accountId,
        shouldSelect
      ) {
        const boxes =
          document.querySelectorAll(
            ".account-" + accountId
          );

        boxes.forEach(function(box) {
          box.checked =
            shouldSelect;
        });

        updateSelectedCount();
      }

      document.addEventListener(
        "change",
        function(event) {
          if (
            event.target &&
            event.target.name === "page_ids"
          ) {
            updateSelectedCount();
          }
        }
      );

      function confirmRemoveAccount() {
        return confirm(
          "Are you sure you want to remove this Facebook account and all of its connected Pages?"
        );
      }

      function handleSync(form) {
        const button =
          form.querySelector(
            "button[type='submit']"
          );

        if (button) {
          button.disabled = true;
          button.innerHTML =
            "Syncing Pages...";
        }

        return true;
      }

      function handleMediaChange(input) {
        const selected =
          document.getElementById(
            "media-selected"
          );

        const name =
          document.getElementById(
            "media-name"
          );

        const dropzone =
          document.getElementById(
            "media-dropzone"
          );

        if (
          input.files &&
          input.files.length
        ) {
          name.textContent =
            input.files[0].name;

          selected.classList.remove(
            "hidden"
          );

          dropzone.classList.add(
            "has-file"
          );
        } else {
          clearMedia();
        }
      }

      function clearMedia() {
        const input =
          document.getElementById(
            "media"
          );

        const selected =
          document.getElementById(
            "media-selected"
          );

        const dropzone =
          document.getElementById(
            "media-dropzone"
          );

        if (input) {
          input.value = "";
        }

        if (selected) {
          selected.classList.add(
            "hidden"
          );
        }

        if (dropzone) {
          dropzone.classList.remove(
            "has-file"
          );
        }
      }

      const messageInput =
        document.getElementById(
          "message"
        );

      if (messageInput) {
        messageInput.addEventListener(
          "input",
          function() {
            const count =
              document.getElementById(
                "char-count"
              );

            if (count) {
              count.textContent =
                this.value.length +
                " characters";
            }
          }
        );
      }

      function showProgress() {
        const section =
          document.getElementById(
            "publish-progress-section"
          );

        if (section) {
          section.classList.remove(
            "hidden"
          );
        }

        const results =
          document.getElementById(
            "publish-results-section"
          );

        if (results) {
          results.classList.add(
            "hidden"
          );
        }
      }

      function hideProgress() {
        const section =
          document.getElementById(
            "publish-progress-section"
          );

        if (section) {
          section.classList.add(
            "hidden"
          );
        }
      }

      function updateProgress(
        processed,
        total,
        message
      ) {
        const safeTotal =
          Math.max(
            Number(total) || 0,
            1
          );

        const safeProcessed =
          Math.max(
            0,
            Math.min(
              Number(processed) || 0,
              safeTotal
            )
          );

        const percent =
          Math.round(
            (safeProcessed /
              safeTotal) *
              100
          );

        const bar =
          document.getElementById(
            "progress-bar"
          );

        const percentText =
          document.getElementById(
            "progress-percent"
          );

        const count =
          document.getElementById(
            "progress-count"
          );

        const status =
          document.getElementById(
            "progress-status"
          );

        const progressMessage =
          document.getElementById(
            "progress-message"
          );

        if (bar) {
          bar.style.width =
            percent + "%";
        }

        if (percentText) {
          percentText.textContent =
            percent + "%";
        }

        if (count) {
          count.textContent =
            safeProcessed +
            " / " +
            total +
            " Pages";
        }

        if (status) {
          status.textContent =
            safeProcessed >= safeTotal
              ? "Complete"
              : "Publishing...";
        }

        if (
          progressMessage &&
          message
        ) {
          progressMessage.textContent =
            message;
        }
      }

      function showResults(
        results
      ) {
        const section =
          document.getElementById(
            "publish-results-section"
          );

        const list =
          document.getElementById(
            "results-list"
          );

        const summary =
          document.getElementById(
            "results-summary"
          );

        if (!section || !list) {
          return;
        }

        section.classList.remove(
          "hidden"
        );

        list.innerHTML = "";

        let successCount = 0;
        let failureCount = 0;

        (results || []).forEach(
          function(item) {
            if (
              item.status ===
              "success"
            ) {
              successCount++;
            } else {
              failureCount++;
            }

            const row =
              document.createElement(
                "div"
              );

            row.className =
              "result-row " +
              (item.status ===
              "success"
                ? "result-success"
                : "result-failure");

            const icon =
              item.status ===
              "success"
                ? "✓"
                : "!";

            row.innerHTML =
              '<div class="result-status">' +
              icon +
              "</div>" +
              '<div class="result-info">' +
              '<div class="result-page-name">' +
              escapeClientHtml(
                item.page_name ||
                  "Unnamed Page"
              ) +
              "</div>" +
              '<div class="result-detail">' +
              escapeClientHtml(
                item.error ||
                  (item.post_id
                    ? "Published successfully"
                    : "Completed")
              ) +
              "</div>" +
              "</div>";
            
            list.appendChild(row);
          }
        );

        if (summary) {
          summary.innerHTML =
            '<span class="result-success-count">' +
            successCount +
            " successful</span>" +
            '<span class="result-failure-count">' +
            failureCount +
            " failed</span>";
        }
      }

      function escapeClientHtml(
        value
      ) {
        const div =
          document.createElement(
            "div"
          );

        div.textContent =
          String(
            value == null
              ? ""
              : value
          );

        return div.innerHTML;
      }

      async function handlePublish(
        event
      ) {
        event.preventDefault();

        const form =
          document.getElementById(
            "publish-form"
          );

        const button =
          document.getElementById(
            "publish-btn"
          );

        const selected =
          Array.from(
            document.querySelectorAll(
              'input[name="page_ids"]:checked'
            )
          );

        const message =
          document.getElementById(
            "message"
          ).value.trim();

        const media =
          document.getElementById(
            "media"
          );

        if (!selected.length) {
          alert(
            "Please select at least one Facebook Page."
          );
          return false;
        }

        if (
          !message &&
          !(
            media.files &&
            media.files.length
          )
        ) {
          alert(
            "Please enter a message or select an image/video."
          );
          return false;
        }

        const total =
          selected.length;

        if (total > PUBLISH_BATCH_SIZE) {
          const confirmed =
            confirm(
              "You selected " +
                total +
                " Pages. The system will automatically publish them in batches of " +
                PUBLISH_BATCH_SIZE +
                ". Continue?"
            );

          if (!confirmed) {
            return false;
          }
        }

        if (button) {
          button.disabled = true;

          button.innerHTML =
            "<span>Preparing...</span>";
        }

        showProgress();

        updateProgress(
          0,
          total,
          "Preparing your post..."
        );

        try {
          const startData =
            new FormData();

          startData.append(
            "message",
            message
          );

          selected.forEach(
            function(box) {
              startData.append(
                "page_ids",
                box.value
              );
            }
          );

          if (
            media.files &&
            media.files.length
          ) {
            startData.append(
              "media",
              media.files[0]
            );
          }

          const startResponse =
            await fetch(
              "/publish",
              {
                method: "POST",
                body: startData,
                credentials:
                  "same-origin",
                cache: "no-store"
              }
            );

          const startResult =
            await readApiResponse(
              startResponse
            );

          const runId =
            startResult.runId;

          if (!runId) {
            throw new Error(
              "The server did not return a publishing run ID."
            );
          }

          const allPageIds =
            selected.map(
              function(box) {
                return box.value;
              }
            );

          let processed = 0;
          let finalResults = [];

          for (
            let index = 0;
            index <
            allPageIds.length;
            index +=
              PUBLISH_BATCH_SIZE
          ) {
            const batch =
              allPageIds.slice(
                index,
                index +
                  PUBLISH_BATCH_SIZE
              );

            updateProgress(
              processed,
              total,
              "Publishing batch " +
                (Math.floor(
                  index /
                    PUBLISH_BATCH_SIZE
                ) +
                  1) +
                "..."
            );

            const batchForm =
              new FormData();

            batchForm.append(
              "run_id",
              runId
            );

            batch.forEach(
              function(pageId) {
                batchForm.append(
                  "page_ids",
                  pageId
                );
              }
            );

            if (
              media.files &&
              media.files.length
            ) {
              batchForm.append(
                "media",
                media.files[0]
              );
            }

            const batchResponse =
              await fetch(
                "/publish-batch",
                {
                  method: "POST",
                  body: batchForm,
                  credentials:
                    "same-origin",
                  cache: "no-store"
                }
              );

            const batchResult =
              await readApiResponse(
                batchResponse
              );

            if (
              Array.isArray(
                batchResult.results
              )
            ) {
              finalResults =
                finalResults.concat(
                  batchResult.results
                );
            }

            processed +=
              batch.length;

            updateProgress(
              processed,
              total,
              batchResult.complete
                ? "Publishing complete."
                : "Publishing the next batch..."
            );

            if (
              !batchResult.complete &&
              batchResult.pending >
                0
            ) {
              await sleep(150);
            }
          }

          updateProgress(
            total,
            total,
            "All selected Pages have been processed."
          );

          hideProgress();

          showResults(
            finalResults
          );

          if (button) {
            button.disabled = false;

            button.innerHTML =
              "<span>Publish to Selected Pages</span>" +
              '<svg viewBox="0 0 24 24">' +
              '<path d="M5 12h14"/>' +
              '<path d="m13 6 6 6-6 6"/>' +
              "</svg>";
          }

          alert(
            "Publishing process completed."
          );

        } catch (error) {
          console.error(
            "Publishing error:",
            error
          );

          hideProgress();

          if (button) {
            button.disabled =
              false;

            button.innerHTML =
              "<span>Publish to Selected Pages</span>" +
              '<svg viewBox="0 0 24 24">' +
              '<path d="M5 12h14"/>' +
              '<path d="m13 6 6 6-6 6"/>' +
              "</svg>";
          }

          alert(
            "Publishing failed: " +
              (
                error &&
                error.message
                  ? error.message
                  : String(error)
              )
          );
        }

        return false;
      }

      updateSelectedCount();
    </script>
    `
  );
}
          <div class="password-wrap">
            <input
              id="password"
              type="password"
              name="password"
              placeholder="Enter your password"
              autocomplete="current-password"
              required
              autofocus
            />

            <button
              type="button"
              class="show-password"
              onclick="togglePassword()"
              aria-label="Show password"
            >
              <svg
                id="eyeIcon"
                viewBox="0 0 24 24"
              >
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
                <circle
                  cx="12"
                  cy="12"
                  r="2.5"
                />
              </svg>
            </button>
          </div>

          <button
            type="submit"
            class="login-submit"
          >
            <span>Enter Dashboard</span>

            <svg viewBox="0 0 24 24">
              <path d="M5 12h14"/>
              <path d="m13 6 6 6-6 6"/>
            </svg>
          </button>
        </form>

        <div class="login-security">
          <span class="security-dot"></span>
          Protected dashboard session
        </div>

      </div>
    </div>

    <script>
      function togglePassword() {
        const input =
          document.getElementById("password");

        const icon =
          document.getElementById("eyeIcon");

        if (input.type === "password") {
          input.type = "text";

          icon.innerHTML =
            '<path d="M3 3l18 18"/>' +
            '<path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>' +
            '<path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 3.8"/>' +
            '<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 3.1-.5"/>';
        } else {
          input.type = "password";

          icon.innerHTML =
            '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>' +
            '<circle cx="12" cy="12" r="2.5"/>';
        }
      }
    </script>
    `
  );
}

// =============================================================
// DATABASE
// =============================================================

async function ensureDatabaseSchema(db) {
  if (!db) {
    throw new Error(
      "D1 database binding DB is missing. Check your Cloudflare Worker D1 binding name."
    );
  }

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS accounts (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "facebook_user_id TEXT NOT NULL UNIQUE, " +
        "account_name TEXT, " +
        "access_token TEXT NOT NULL, " +
        "created_at TEXT DEFAULT (datetime('now'))" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS pages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "facebook_page_id TEXT NOT NULL UNIQUE, " +
        "page_name TEXT, " +
        "access_token TEXT NOT NULL, " +
        "account_id INTEGER NOT NULL, " +
        "created_at TEXT DEFAULT (datetime('now'))" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_pages_account_id " +
        "ON pages(account_id)"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS auth_sessions (" +
        "id TEXT PRIMARY KEY, " +
        "created_at TEXT NOT NULL, " +
        "dashboard_ticket INTEGER NOT NULL DEFAULT 0" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS publish_runs (" +
        "id TEXT PRIMARY KEY, " +
        "session_id TEXT NOT NULL, " +
        "message TEXT, " +
        "media_type TEXT, " +
        "media_name TEXT, " +
        "created_at TEXT NOT NULL, " +
        "completed_at TEXT, " +
        "status TEXT NOT NULL DEFAULT 'processing'" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS publish_run_pages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "run_id TEXT NOT NULL, " +
        "page_db_id INTEGER NOT NULL, " +
        "facebook_page_id TEXT NOT NULL, " +
        "page_name TEXT, " +
        "status TEXT NOT NULL DEFAULT 'pending', " +
        "post_id TEXT, " +
        "error TEXT, " +
        "created_at TEXT NOT NULL, " +
        "completed_at TEXT, " +
        "UNIQUE(run_id, page_db_id)" +
        ")"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_publish_run_pages_run_id " +
        "ON publish_run_pages(run_id)"
    )
    .run();

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS " +
        "idx_publish_run_pages_status " +
        "ON publish_run_pages(run_id, status)"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM auth_sessions " +
        "WHERE created_at < datetime('now', '-1 day')"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM publish_runs " +
        "WHERE created_at < datetime('now', '-2 day')"
    )
    .run();

  await db
    .prepare(
      "DELETE FROM publish_run_pages " +
        "WHERE run_id NOT IN " +
        "(SELECT id FROM publish_runs)"
    )
    .run();
}

// =============================================================
// META CONFIG
// =============================================================

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

  if (missing.length) {
    throw new Error(
      "Meta configuration is missing: " +
        missing.join(", ") +
        ". Make sure these exact names exist in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  if (!graphVersion.startsWith("v")) {
    graphVersion = "v" + graphVersion;
  }

  return {
    appId,
    appSecret,
    graphVersion
  };
}

// =============================================================
// DASHBOARD
// =============================================================

async function showDashboard(env) {
  const accountsResult =
    await env.DB.prepare(
      "SELECT id, facebook_user_id, account_name, created_at " +
        "FROM accounts ORDER BY id ASC"
    ).all();

  const accounts =
    accountsResult.results || [];

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, account_id " +
        "FROM pages " +
        "ORDER BY account_id ASC, " +
        "page_name COLLATE NOCASE ASC"
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

  const totalAccounts =
    accounts.length;

  const totalPages =
    pages.length;

  let accountHtml = "";

  if (!accounts.length) {
    accountHtml = `
      <section class="empty-state">

        <div class="empty-icon">
          <svg viewBox="0 0 24 24">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M19 8v6"/>
            <path d="M22 11h-6"/>
          </svg>
        </div>

        <div class="eyebrow">
          GET STARTED
        </div>

        <h3>
          No Facebook account connected
        </h3>

        <p>
          Connect your Facebook account to bring your Pages
          into the publishing command center.
        </p>

        <a class="primary-btn" href="/auth/meta">
          <span class="fb-symbol">f</span>
          Connect Facebook Account
        </a>

      </section>
    `;
  } else {
    for (const account of accounts) {
      const accountPages =
        groupedPages[account.id] || [];

      let pageHtml = "";

      if (accountPages.length) {
        pageHtml = `
          <div class="page-toolbar">

            <div>
              <div class="toolbar-title">
                Connected Pages
              </div>

              <div class="toolbar-subtitle">
                Select the Pages you want to publish to
              </div>
            </div>

            <div class="toolbar-actions">

              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(
                  account.id
                )}, true)"
              >
                Select all
              </button>

              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(
                  account.id
                )}, false)"
              >
                Clear
              </button>

            </div>
          </div>

          <div class="page-list">
        `;

        for (const p of accountPages) {
          const initial =
            getInitials(
              p.page_name || "Page"
            );

          pageHtml += `
            <label class="page-row">

              <input
                class="page-checkbox account-${Number(
                  account.id
                )}"
                type="checkbox"
                name="page_ids"
                value="${escapeHtml(p.id)}"
                form="publish-form"
              />

              <span class="custom-check">
                <svg viewBox="0 0 24 24">
                  <path d="m5 12 4 4L19 6"/>
                </svg>
              </span>

              <span class="page-avatar">
                ${escapeHtml(initial)}
              </span>

              <span class="page-info">

                <span class="page-name">
                  ${escapeHtml(
                    p.page_name ||
                      "Unnamed Page"
                  )}
                </span>

                <span class="page-id">
                  ID:
                  ${escapeHtml(
                    p.facebook_page_id
                  )}
                </span>

              </span>

              <span class="page-ready">
                <span class="ready-dot"></span>
                Ready
              </span>

            </label>
          `;
        }

        pageHtml += `</div>`;
      } else {
        pageHtml = `
          <div class="no-pages">

            <div class="no-pages-icon">
              !
            </div>

            <div>
              <strong>
                No Pages found
              </strong>

              <p>
                Click <b>Sync Pages</b> to refresh
                this Facebook account.
              </p>
            </div>

          </div>
        `;
      }

      const accountInitials =
        getInitials(
          account.account_name ||
            "Facebook Account"
        );

      accountHtml += `
        <section class="account-card">

          <div class="account-top">

            <div class="account-identity">

              <div class="account-avatar">
                ${escapeHtml(
                  accountInitials
                )}
              </div>

              <div class="account-details">

                <div class="account-name-line">

                  <h2>
                    ${escapeHtml(
                      account.account_name ||
                        "Facebook Account"
                    )}
                  </h2>

                  <span class="connected-badge">
                    <span></span>
                    Connected
                  </span>

                </div>

                <div class="facebook-id">
                  Facebook ID:
                  <code>
                    ${escapeHtml(
                      account.facebook_user_id
                    )}
                  </code>
                </div>

                <div class="account-meta">
                  <span>
                    <strong>
                      ${accountPages.length}
                    </strong>
                    Connected Page${
                      accountPages.length === 1
                        ? ""
                        : "s"
                    }
                  </span>
                </div>

              </div>
            </div>

            <div class="account-actions">

              <form
                method="POST"
                action="/sync"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtml(
                    account.id
                  )}"
                />

                <button
                  class="action-btn sync-btn"
                  type="submit"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10"/>
                    <path d="M3 5v5h5"/>
                    <path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14"/>
                    <path d="M21 19v-5h-5"/>
                  </svg>
                  Sync Pages
                </button>
              </form>

              <form
                method="POST"
                action="/remove-account"
                onsubmit="return confirm('Remove this Facebook account and all its connected Pages?');"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtml(
                    account.id
                  )}"
                />

                <button
                  class="action-btn remove-btn"
                  type="submit"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M3 6h18"/>
                    <path d="M8 6V4h8v2"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v5"/>
                    <path d="M14 11v5"/>
                  </svg>
                  Remove
                </button>
              </form>

            </div>
          </div>

          <div class="pages-area">
            ${pageHtml}
          </div>

        </section>
      `;
    }
  }

  let publisherHtml = "";

  if (
    accounts.length > 0 &&
    pages.length > 0
  ) {
    publisherHtml = `
      <section class="studio-card">

        <div class="studio-heading">

          <div class="studio-title-wrap">

            <div class="studio-icon">
              <svg viewBox="0 0 24 24">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>
              </svg>
            </div>

            <div>
              <div class="eyebrow">
                PUBLISHING STUDIO
              </div>

              <h2>
                Create &amp; Publish
              </h2>

              <p>
                Compose once and publish to multiple
                Facebook Pages.
              </p>
            </div>

          </div>

          <div
            id="selected-count"
            class="selected-pill"
          >
            <span class="selected-dot"></span>
            0 Pages Selected
          </div>

        </div>

        <form
          id="publish-form"
          method="POST"
          action="/publish"
          enctype="multipart/form-data"
        >

          <div class="composer-box">

            <div class="composer-top">
              <label for="message">
                Post Content
              </label>

              <span id="char-count">
                0 characters
              </span>
            </div>

            <textarea
              id="message"
              name="message"
              rows="7"
              maxlength="63206"
              placeholder="What would you like to publish today?"
            ></textarea>

          </div>

          <div
            class="upload-box"
            id="upload-box"
          >

            <input
              id="media"
              type="file"
              name="media"
              accept="image/*,video/*"
            />

            <div class="upload-icon">
              <svg viewBox="0 0 24 24">
                <path d="M12 16V4"/>
                <path d="m7 9 5-5 5 5"/>
                <path d="M5 20h14"/>
              </svg>
            </div>

            <div class="upload-title">
              Add image or video
            </div>

            <div class="upload-subtitle">
              Click here to choose a media file
            </div>

            <div
              id="file-name"
              class="file-name"
            ></div>

            <div class="upload-hint">
              Optional &nbsp;•&nbsp; Maximum 100 MB
            </div>

          </div>

          <div class="publish-footer">

            <div class="publish-info">

              <div class="publish-info-icon">
                ✓
              </div>

              <div>
                <strong>
                  Ready to publish
                </strong>

                <span id="publish-target-text">
                  Select one or more Pages above
                </span>
              </div>

            </div>

            <button
              class="publish-btn"
              id="publish-btn"
              type="submit"
            >

              <span class="publish-btn-text">
                Publish to Pages
              </span>

              <svg
                class="publish-arrow"
                viewBox="0 0 24 24"
              >
                <path d="M5 12h14"/>
                <path d="m13 6 6 6-6 6"/>
              </svg>

              <span class="publish-spinner"></span>

            </button>

          </div>

        </form>

      </section>
    `;
  }

  const script = `
<script>
  function updateSelectedCount() {
    const checked =
      document.querySelectorAll(
        ".page-checkbox:checked"
      );

    const counter =
      document.getElementById(
        "selected-count"
      );

    const targetText =
      document.getElementById(
        "publish-target-text"
      );

    if (counter) {
      counter.innerHTML =
        '<span class="selected-dot"></span>' +
        checked.length +
        " Page" +
        (checked.length === 1 ? "" : "s") +
        " Selected";
    }

    if (targetText) {
      if (checked.length === 0) {
        targetText.textContent =
          "Select one or more Pages above";
      } else {
        targetText.textContent =
          checked.length +
          " Page" +
          (checked.length === 1 ? "" : "s") +
          " selected for publishing";
      }
    }

    document
      .querySelectorAll(".page-row")
      .forEach(function(row) {
        const checkbox =
          row.querySelector(
            ".page-checkbox"
          );

        if (
          checkbox &&
          checkbox.checked
        ) {
          row.classList.add(
            "selected"
          );
        } else {
          row.classList.remove(
            "selected"
          );
        }
      });
  }

  function selectAccountPages(
    accountId,
    select
  ) {
    document
      .querySelectorAll(
        ".account-" + accountId
      )
      .forEach(function(c) {
        c.checked = select;
      });

    updateSelectedCount();
  }

  document.addEventListener(
    "change",
    function(e) {
      if (
        e.target &&
        e.target.classList.contains(
          "page-checkbox"
        )
      ) {
        updateSelectedCount();
      }
    }
  );

  const message =
    document.getElementById(
      "message"
    );

  const charCount =
    document.getElementById(
      "char-count"
    );

  if (
    message &&
    charCount
  ) {
    message.addEventListener(
      "input",
      function() {
        charCount.textContent =
          message.value.length +
          " characters";
      }
    );
  }

  const media =
    document.getElementById(
      "media"
    );

  const fileName =
    document.getElementById(
      "file-name"
    );

  const uploadBox =
    document.getElementById(
      "upload-box"
    );

  if (media) {
    media.addEventListener(
      "change",
      function() {
        if (
          media.files &&
          media.files.length
        ) {
          fileName.textContent =
            "Selected: " +
            media.files[0].name;

          uploadBox.classList.add(
            "has-file"
          );
        } else {
          fileName.textContent = "";

          uploadBox.classList.remove(
            "has-file"
          );
        }
      }
    );
  }

  if (
    uploadBox &&
    media
  ) {
    uploadBox.addEventListener(
      "click",
      function(e) {
        if (e.target !== media) {
          media.click();
        }
      }
    );
  }

  // =======================================================
  // BATCH PUBLISHING
  // =======================================================

  const PUBLISH_BATCH_SIZE = 15;

  function sleep(ms) {
    return new Promise(
      function(resolve) {
        setTimeout(
          resolve,
          ms
        );
      }
    );
  }

  // Always read API responses safely. If the Worker/Cloudflare
  // returns HTML instead of JSON, show a useful error instead of
  // throwing an unhelpful JSON parsing error.
  async function readApiResponse(response) {
    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (parseError) {
      const cleaned = text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      throw new Error(
        cleaned ||
        ("Server returned HTTP " + response.status)
      );
    }

    if (!response.ok) {
      throw new Error(
        data && data.error
          ? String(data.error)
          : ("Server returned HTTP " + response.status)
      );
    }

    return data;
  }

  async function publishInBatches(
    selectedIds
  ) {
    const btn =
      document.getElementById(
        "publish-btn"
      );

    const btnText =
      btn
        ? btn.querySelector(
            ".publish-btn-text"
          )
        : null;

    const arrow =
      btn
        ? btn.querySelector(
            ".publish-arrow"
          )
        : null;

    const spinner =
      btn
        ? btn.querySelector(
            ".publish-spinner"
          )
        : null;

    const originalText =
      btnText
        ? btnText.textContent
        : "Publish to Pages";

    if (btn) {
      btn.disabled = true;
      btn.classList.add(
        "loading"
      );
    }

    const baseForm =
      document.getElementById(
        "publish-form"
      );

    if (!baseForm) {
      throw new Error(
        "Publish form was not found."
      );
    }

    const messageValue =
      message
        ? message.value
        : "";

    const mediaFile =
      media &&
      media.files &&
      media.files.length
        ? media.files[0]
        : null;

    const startData =
      new FormData();

    startData.append(
      "message",
      messageValue
    );

    selectedIds.forEach(
      function(id) {
        startData.append(
          "page_ids",
          id
        );
      }
    );

    if (mediaFile) {
      startData.append(
        "media",
        mediaFile
      );
    }

    const startResponse =
      await fetch(
        "/publish",
        {
          method: "POST",
          body: startData,
          credentials:
            "same-origin",
          cache: "no-store"
        }
      );

    const startResult =
      await readApiResponse(
        startResponse
      );

    if (
      !startResult ||
      !startResult.runId
    ) {
      throw new Error(
        "Publishing run could not be created."
      );
    }

    const runId =
      startResult.runId;

    let completed = 0;

    const total =
      selectedIds.length;

    for (
      let offset = 0;
      offset < selectedIds.length;
      offset += PUBLISH_BATCH_SIZE
    ) {
      const batch =
        selectedIds.slice(
          offset,
          offset +
            PUBLISH_BATCH_SIZE
        );

      const batchForm =
        new FormData();

      batchForm.append(
        "run_id",
        runId
      );

      batch.forEach(
        function(id) {
          batchForm.append(
            "page_ids",
            id
          );
        }
      );

      if (mediaFile) {
        batchForm.append(
          "media",
          mediaFile
        );
      }

      const batchResponse =
        await fetch(
          "/publish-batch",
          {
            method: "POST",
            body: batchForm,
            credentials:
              "same-origin",
            cache: "no-store"
          }
        );

      const batchResult =
        await readApiResponse(
          batchResponse
        );

      if (
        batchResult &&
        batchResult.error
      ) {
        throw new Error(
          batchResult.error
        );
      }

      completed +=
        batch.length;

      if (btnText) {
        btnText.textContent =
          "Publishing " +
          completed +
          " / " +
          total;
      }

      if (
        completed < total
      ) {
        await sleep(450);
      }
    }

    window.location.href =
      "/publish-results?run_id=" +
      encodeURIComponent(runId);
  }

  const publishForm =
    document.getElementById(
      "publish-form"
    );

  if (publishForm) {
    publishForm.addEventListener(
      "submit",
      async function(e) {
        e.preventDefault();

        const selected =
          Array.from(
            document.querySelectorAll(
              ".page-checkbox:checked"
            )
          ).map(
            function(c) {
              return c.value;
            }
          );

        const text =
          message
            ? message.value.trim()
            : "";

        const hasMedia =
          media &&
          media.files &&
          media.files.length > 0;

        if (!selected.length) {
          alert(
            "Please select at least one Facebook Page."
          );
          return;
        }

        if (
          !text &&
          !hasMedia
        ) {
          alert(
            "Please enter post text or select an image/video."
          );
          return;
        }

        if (
          selected.length > 15
        ) {
          const ok =
            confirm(
              "You selected " +
              selected.length +
              " Pages. They will be published in small batches automatically. Continue?"
            );

          if (!ok) {
            return;
          }
        }

        try {
          await publishInBatches(
            selected
          );
        } catch (error) {
          console.error(error);

          const btn =
            document.getElementById(
              "publish-btn"
            );

          if (btn) {
            btn.disabled =
              false;

            btn.classList.remove(
              "loading"
            );
          }

          alert(
            "Publishing stopped: " +
            (
              error &&
              error.message
                ? error.message
                : String(error)
            )
          );
        }
      }
    );
  }

  document
    .querySelectorAll(
      ".page-row"
    )
    .forEach(
      function(row) {
        row.addEventListener(
          "click",
          function(e) {
            if (
              e.target.closest(
                "button"
              ) ||
              e.target.closest(
                "a"
              )
            ) {
              return;
            }

            const checkbox =
              row.querySelector(
                ".page-checkbox"
              );

            if (
              e.target !== checkbox &&
              !e.target.closest(
                ".custom-check"
              )
            ) {
              checkbox.checked =
                !checkbox.checked;
            }

            updateSelectedCount();
          }
        );
      }
    );

  updateSelectedCount();
</script>
`;

  const header = `
<header class="dashboard-header">
  <div class="header-inner">

    <div class="brand-area">

      <div class="brand-mark header-mark">
        <span>f</span>
      </div>

      <div class="brand-copy">

        <div class="brand-name">
          NAQI SHAH
        </div>

        <div class="brand-mini">
          PUBLISHING COMMAND CENTER
        </div>

      </div>
    </div>

    <div class="header-actions">

      <a
        class="connect-account-btn"
        href="/auth/meta"
      >
        <span class="plus-icon">+</span>
        Connect Facebook
      </a>

      <form
        method="POST"
        action="/logout"
      >
        <button
          class="header-logout"
          type="submit"
        >
          <svg viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <path d="M16 17l5-5-5-5"/>
            <path d="M21 12H9"/>
          </svg>
          Logout
        </button>
      </form>

    </div>

  </div>
</header>
`;

  const hero = `
<section class="hero">
  <div class="hero-glow"></div>

  <div class="hero-content">

    <div class="eyebrow hero-eyebrow">
      META SOCIAL PUBLISHING
    </div>

    <h1>
      Your Facebook
      <span>
        Publishing Command Center.
      </span>
    </h1>

    <p>
      Manage connected accounts, select Pages and publish
      content across your entire Facebook network from one place.
    </p>

  </div>

  <div class="hero-decoration">

    <div class="floating-card floating-one">
      <span class="mini-status"></span>
      Pages Ready
      <strong>${totalPages}</strong>
    </div>

    <div class="floating-card floating-two">
      <span class="mini-facebook">f</span>
      Connected
      <strong>${totalAccounts}</strong>
    </div>

  </div>
</section>
`;

  const stats = `
<section class="stats-grid">

  <div class="stat-card">

    <div class="stat-icon accounts-icon">
      <svg viewBox="0 0 24 24">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </div>

    <div class="stat-data">
      <span>Connected Accounts</span>
      <strong>${totalAccounts}</strong>
      <small>Facebook accounts</small>
    </div>

  </div>

  <div class="stat-card">

    <div class="stat-icon pages-icon">
      <svg viewBox="0 0 24 24">
        <rect
          x="3"
          y="3"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="14"
          y="3"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="3"
          y="14"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="14"
          y="14"
          width="7"
          height="7"
          rx="1"
        />
      </svg>
    </div>

    <div class="stat-data">
      <span>Total Pages</span>
      <strong>${totalPages}</strong>
      <small>
        Available for publishing
      </small>
    </div>

  </div>

  <div class="stat-card stat-highlight">

    <div class="stat-icon ready-icon">
      <svg viewBox="0 0 24 24">
        <path d="m5 12 4 4L19 6"/>
      </svg>
    </div>

    <div class="stat-data">
      <span>System Status</span>
      <strong>Ready</strong>
      <small>
        Publishing command center online
      </small>
    </div>

  </div>

</section>
`;

  return page(
    APP_NAME,
    header +
      `<main class="dashboard-container">${hero}${stats}${accountHtml}${publisherHtml}</main>` +
      script
  );
}

// =============================================================
// META LOGIN
// =============================================================

function startMetaLogin(
  request,
  env,
  sessionId
) {
  const config =
    getMetaConfig(env);

  const requestUrl =
    new URL(request.url);

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
    encodeURIComponent(
      config.appId
    ) +
    "&redirect_uri=" +
    encodeURIComponent(
      redirectUri
    ) +
    "&scope=" +
    encodeURIComponent(
      scope
    ) +
    "&state=" +
    encodeURIComponent(
      state
    ) +
    "&auth_type=reauthorize";

  return new Response(null, {
    status: 302,
    headers: {
      Location: loginUrl,
      "Set-Cookie":
        "meta_oauth_state=" +
        encodeURIComponent(state) +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
      "Cache-Control": "no-store"
    }
  });
}

async function metaCallback(
  request,
  env,
  sessionId
) {
  const config =
    getMetaConfig(env);

  const url =
    new URL(request.url);

  const code =
    url.searchParams.get(
      "code"
    );

  const error =
    url.searchParams.get(
      "error"
    );

  const errorDescription =
    url.searchParams.get(
      "error_description"
    );

  if (error) {
    await allowNextDashboardLoad(
      env.DB,
      sessionId
    );

    return page(
      "Facebook Login Error",
      `
      <div class="error-screen">

        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            FACEBOOK AUTHENTICATION
          </div>

          <h2>
            Facebook Login Error
          </h2>

          <p>
            ${escapeHtml(error)}
          </p>

          <p class="error-detail">
            ${escapeHtml(
              errorDescription || ""
            )}
          </p>

          <a
            class="back-btn"
            href="/"
          >
            Back to Dashboard
          </a>

        </div>

      </div>
      `
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
    encodeURIComponent(
      config.appId
    ) +
    "&client_secret=" +
    encodeURIComponent(
      config.appSecret
    ) +
    "&redirect_uri=" +
    encodeURIComponent(
      redirectUri
    ) +
    "&code=" +
    encodeURIComponent(
      code
    );

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
        formatGraphError(
          tokenData
        )
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
        formatGraphError(
          userData
        )
    );
  }

  await env.DB.prepare(
    "INSERT INTO accounts " +
      "(facebook_user_id, account_name, access_token) " +
      "VALUES (?, ?, ?) " +
      "ON CONFLICT(facebook_user_id) DO UPDATE SET " +
      "account_name=excluded.account_name, " +
      "access_token=excluded.access_token"
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

  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        url.origin + "/",
      "Set-Cookie":
        "meta_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store"
    }
  });
}
// =============================================================
// SYNC PAGES
// =============================================================

async function syncPages(
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

  // IMPORTANT:
  // Continue following Meta's paging.next URL.
  // This allows the application to sync more than
  // 100 Pages when Meta returns additional pages.
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
          formatGraphError(
            data
          )
      );
    }

    for (
      const fbPage of
      data.data || []
    ) {
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
          "page_name=excluded.page_name, " +
          "access_token=excluded.access_token, " +
          "account_id=excluded.account_id"
      )
        .bind(
          String(
            fbPage.id
          ),
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

  if (
    foundPageIds.length
  ) {
    const placeholders =
      foundPageIds
        .map(() => "?")
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

// =============================================================
// REMOVE ACCOUNT
// =============================================================

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

// =============================================================
// PUBLISH - START RUN
// =============================================================

async function startPublishRun(
  request,
  env,
  sessionId
) {
  const form =
    await request.formData();

  const message =
    String(
      form.get("message") || ""
    ).trim();

  const selectedPageIds =
    form.getAll(
      "page_ids"
    );

  const media =
    form.get("media");

  if (
    !selectedPageIds.length
  ) {
    return jsonResponse(
      {
        error:
          "Please select at least one Facebook Page."
      },
      400
    );
  }

  if (
    !message &&
    (!media || !media.name)
  ) {
    return jsonResponse(
      {
        error:
          "Please enter post text or select an image/video."
      },
      400
    );
  }

  const numericPageIds =
    selectedPageIds
      .map(Number)
      .filter(
        id =>
          Number.isInteger(id) &&
          id > 0
      );

  if (
    !numericPageIds.length
  ) {
    return jsonResponse(
      {
        error:
          "Invalid selected Page IDs."
      },
      400
    );
  }

  // Remove duplicate IDs so the same Page can never
  // accidentally be inserted twice into one publishing run.
  const uniquePageIds =
    [...new Set(
      numericPageIds
    )];

  const placeholders =
    uniquePageIds
      .map(() => "?")
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name " +
        "FROM pages " +
        "WHERE id IN (" +
        placeholders +
        ") " +
        "ORDER BY page_name COLLATE NOCASE ASC"
    )
      .bind(
        ...uniquePageIds
      )
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    return jsonResponse(
      {
        error:
          "Selected Pages were not found."
      },
      404
    );
  }

  if (
    pages.length !==
    uniquePageIds.length
  ) {
    return jsonResponse(
      {
        error:
          "One or more selected Pages were not found. Please sync Pages and try again."
      },
      400
    );
  }

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
      mediaType =
        "image";
    } else if (
      (media.type || "")
        .startsWith("video/")
    ) {
      mediaType =
        "video";
    } else {
      return jsonResponse(
        {
          error:
            "Unsupported media type. Please use an image or video."
        },
        400
      );
    }

    if (
      typeof media.size === "number" &&
      media.size > 100 * 1024 * 1024
    ) {
      return jsonResponse(
        {
          error:
            "Media file is larger than the 100 MB limit."
        },
        400
      );
    }
  }

  const runId =
    crypto.randomUUID();

  const createdAt =
    new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO publish_runs " +
      "(id, session_id, message, media_type, media_name, created_at, status) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'processing')"
  )
    .bind(
      runId,
      sessionId,
      message,
      mediaType,
      mediaName,
      createdAt
    )
    .run();

  for (
    const p of pages
  ) {
    await env.DB.prepare(
      "INSERT INTO publish_run_pages " +
        "(run_id, page_db_id, facebook_page_id, page_name, status, created_at) " +
        "VALUES (?, ?, ?, ?, 'pending', ?)"
    )
      .bind(
        runId,
        Number(p.id),
        String(
          p.facebook_page_id
        ),
        p.page_name ||
          "Unnamed Page",
        createdAt
      )
      .run();
  }

  return jsonResponse({
    runId,
    total:
      pages.length
  });
}

// =============================================================
// PUBLISH - PROCESS BATCH
// =============================================================

async function processPublishBatch(
  request,
  env,
  sessionId
) {
  const form =
    await request.formData();

  const runId =
    String(
      form.get("run_id") || ""
    ).trim();

  const selectedPageIds =
    form.getAll(
      "page_ids"
    );

  const media =
    form.get("media");

  if (!runId) {
    return jsonResponse(
      {
        error:
          "Publishing run ID is missing."
      },
      400
    );
  }

  const run =
    await env.DB.prepare(
      "SELECT id, session_id, message, media_type, media_name, status " +
        "FROM publish_runs " +
        "WHERE id = ?"
    )
      .bind(runId)
      .first();

  if (!run) {
    return jsonResponse(
      {
        error:
          "Publishing run was not found."
      },
      404
    );
  }

  if (
    String(run.session_id) !==
    String(sessionId)
  ) {
    return jsonResponse(
      {
        error:
          "You are not authorized to process this publishing run."
      },
      403
    );
  }

  if (!selectedPageIds.length) {
    return jsonResponse(
      {
        error:
          "No Pages were supplied for this batch."
      },
      400
    );
  }

  // Server-side safety limit.
  // The browser also uses the same batch size.
  const SERVER_BATCH_LIMIT = 15;

  if (
    selectedPageIds.length >
    SERVER_BATCH_LIMIT
  ) {
    return jsonResponse(
      {
        error:
          "Too many Pages in one batch. Maximum is " +
          SERVER_BATCH_LIMIT +
          "."
      },
      400
    );
  }

  const numericPageIds =
    selectedPageIds
      .map(Number)
      .filter(
        id =>
          Number.isInteger(id) &&
          id > 0
      );

  const uniquePageIds =
    [...new Set(
      numericPageIds
    )];

  if (!uniquePageIds.length) {
    return jsonResponse(
      {
        error:
          "Invalid Page IDs in this batch."
      },
      400
    );
  }

  const config =
    getMetaConfig(env);

  let mediaBuffer = null;

  if (
    media &&
    typeof media === "object" &&
    media.name
  ) {
    if (
      typeof media.size === "number" &&
      media.size >
        100 * 1024 * 1024
    ) {
      return jsonResponse(
        {
          error:
            "Media file is larger than the 100 MB limit."
        },
        400
      );
    }

    mediaBuffer =
      await media.arrayBuffer();
  }

  if (
    run.media_type &&
    !mediaBuffer
  ) {
    return jsonResponse(
      {
        error:
          "This publishing run requires its media file, but no media file was received."
      },
      400
    );
  }

  const placeholders =
    uniquePageIds
      .map(() => "?")
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, access_token " +
        "FROM pages " +
        "WHERE id IN (" +
        placeholders +
        ")"
    )
      .bind(
        ...uniquePageIds
      )
      .all();

  const pages =
    pagesResult.results || [];

  if (
    pages.length !==
    uniquePageIds.length
  ) {
    return jsonResponse(
      {
        error:
          "One or more Pages in this batch could not be found. Please sync Pages and try again."
      },
      400
    );
  }

  const results = [];

  let processed = 0;

  for (
    const p of pages
  ) {
    const runPage =
      await env.DB.prepare(
        "SELECT id, status, post_id, error " +
          "FROM publish_run_pages " +
          "WHERE run_id = ? AND page_db_id = ?"
      )
        .bind(
          runId,
          Number(p.id)
        )
        .first();

    if (!runPage) {
      results.push({
        pageId:
          p.facebook_page_id,
        pageName:
          p.page_name ||
          "Unnamed Page",
        success: false,
        error:
          "This Page is not part of the publishing run."
      });

      continue;
    }

    // If a Page was already published successfully,
    // do not publish it again.
    if (
      runPage.status ===
      "success"
    ) {
      results.push({
        pageId:
          p.facebook_page_id,
        pageName:
          p.page_name ||
          "Unnamed Page",
        success: true,
        postId:
          runPage.post_id ||
          null,
        skipped: true
      });

      continue;
    }

    await env.DB.prepare(
      "UPDATE publish_run_pages " +
        "SET status = 'processing', error = NULL " +
        "WHERE id = ?"
    )
      .bind(
        Number(runPage.id)
      )
      .run();

    try {
      let postResult;

      if (
        run.media_type ===
        "image"
      ) {
        postResult =
          await publishImageToPage(
            config.graphVersion,
            p.facebook_page_id,
            p.access_token,
            run.message || "",
            mediaBuffer,
            media &&
            media.name
              ? media.name
              : run.media_name
          );
      } else if (
        run.media_type ===
        "video"
      ) {
        postResult =
          await publishVideoToPage(
            config.graphVersion,
            p.facebook_page_id,
            p.access_token,
            run.message || "",
            mediaBuffer,
            media &&
            media.name
              ? media.name
              : run.media_name
          );
      } else {
        postResult =
          await publishTextToPage(
            config.graphVersion,
            p.facebook_page_id,
            p.access_token,
            run.message || ""
          );
      }

      const postId =
        postResult &&
        (
          postResult.id ||
          postResult.post_id
        )
          ? String(
              postResult.id ||
              postResult.post_id
            )
          : null;

      await env.DB.prepare(
        "UPDATE publish_run_pages " +
          "SET status = 'success', " +
          "post_id = ?, " +
          "error = NULL, " +
          "completed_at = ? " +
          "WHERE id = ?"
      )
        .bind(
          postId,
          new Date().toISOString(),
          Number(runPage.id)
        )
        .run();

      results.push({
        pageId:
          p.facebook_page_id,
        pageName:
          p.page_name ||
          "Unnamed Page",
        success: true,
        postId
      });

      processed++;
    } catch (error) {
      const errorMessage =
        error &&
        error.message
          ? error.message
          : String(error);

      await env.DB.prepare(
        "UPDATE publish_run_pages " +
          "SET status = 'failed', " +
          "error = ?, " +
          "completed_at = ? " +
          "WHERE id = ?"
      )
        .bind(
          errorMessage,
          new Date().toISOString(),
          Number(runPage.id)
        )
        .run();

      results.push({
        pageId:
          p.facebook_page_id,
        pageName:
          p.page_name ||
          "Unnamed Page",
        success: false,
        error:
          errorMessage
      });

      processed++;
    }
  }

  const remaining =
    await env.DB.prepare(
      "SELECT " +
        "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, " +
        "SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing " +
        "FROM publish_run_pages " +
        "WHERE run_id = ?"
    )
      .bind(runId)
      .first();

  const pending =
    Number(
      remaining &&
      remaining.pending
        ? remaining.pending
        : 0
    );

  const processing =
    Number(
      remaining &&
      remaining.processing
        ? remaining.processing
        : 0
    );

  const complete =
    pending === 0 &&
    processing === 0;

  if (complete) {
    await env.DB.prepare(
      "UPDATE publish_runs " +
        "SET status = 'completed', " +
        "completed_at = ? " +
        "WHERE id = ?"
    )
      .bind(
        new Date().toISOString(),
        runId
      )
      .run();

    await allowNextDashboardLoad(
      env.DB,
      sessionId
    );
  }

  return jsonResponse({
    runId,
    processed,
    pending,
    complete,
    results
  });
}
// =============================================================
// PUBLISH RESULTS
// =============================================================

async function showPublishResults(
  request,
  env,
  sessionId
) {
  const url =
    new URL(request.url);

  const runId =
    String(
      url.searchParams.get(
        "run_id"
      ) || ""
    ).trim();

  if (!runId) {
    throw new Error(
      "Publishing run ID is missing."
    );
  }

  const run =
    await env.DB.prepare(
      "SELECT id, session_id, status, created_at, completed_at " +
        "FROM publish_runs WHERE id = ?"
    )
      .bind(runId)
      .first();

  if (!run) {
    throw new Error(
      "Publishing run was not found."
    );
  }

  if (
    String(run.session_id) !==
    String(sessionId)
  ) {
    throw new Error(
      "This publishing run does not belong to the current session."
    );
  }

  const resultsResult =
    await env.DB.prepare(
      "SELECT page_name, facebook_page_id, status, post_id, error " +
        "FROM publish_run_pages " +
        "WHERE run_id = ? " +
        "ORDER BY id ASC"
    )
      .bind(runId)
      .all();

  const results =
    resultsResult.results || [];

  const successCount =
    results.filter(
      r =>
        String(r.status) ===
        "success"
    ).length;

  const failedCount =
    results.filter(
      r =>
        String(r.status) ===
        "failed"
    ).length;

  const processingCount =
    results.filter(
      r =>
        String(r.status) !==
          "success" &&
        String(r.status) !==
          "failed"
    ).length;

  let resultsHtml = "";

  for (
    const r of results
  ) {
    const success =
      String(r.status) ===
      "success";

    const failed =
      String(r.status) ===
      "failed";

    resultsHtml += `
      <div class="result-row ${
        success
          ? "result-success"
          : failed
          ? "result-failed"
          : ""
      }">

        <div class="result-main">

          <div class="result-avatar">
            ${escapeHtml(
              getInitials(
                r.page_name ||
                  "Page"
              )
            )}
          </div>

          <div>

            <strong>
              ${escapeHtml(
                r.page_name ||
                  "Unnamed Page"
              )}
            </strong>

            <div class="result-page-id">
              Page ID:
              ${escapeHtml(
                r.facebook_page_id
              )}
            </div>

          </div>

        </div>

        <div class="result-status ${
          success
            ? "status-success"
            : failed
            ? "status-failed"
            : ""
        }">

          <span>
            ${
              success
                ? "✓"
                : failed
                ? "×"
                : "•"
            }
          </span>

          ${
            success
              ? "Published"
              : failed
              ? "Failed"
              : "Processing"
          }

        </div>

        ${
          success
            ? r.post_id
              ? `
                <div class="result-extra success-extra">
                  Post ID:
                  ${escapeHtml(
                    r.post_id
                  )}
                </div>
              `
              : ""
            : failed
            ? `
              <div class="result-extra">
                ${escapeHtml(
                  r.error || ""
                )}
              </div>
            `
            : ""
        }

      </div>
    `;
  }

  return page(
    "Publish Results",
    `
    <div class="results-page">

      <div class="results-topbar">

        <a
          href="/"
          class="results-brand"
        >

          <div class="brand-mark small-mark">
            <span>f</span>
          </div>

          <div>
            <div class="brand-name">
              META PUBLISHER
            </div>

            <div class="brand-mini">
              COMMAND CENTER
            </div>
          </div>

        </a>

        <form
          method="POST"
          action="/logout"
        >
          <button
            class="header-logout"
            type="submit"
          >
            Logout
          </button>
        </form>

      </div>

      <div class="results-container">

        <div class="results-hero">

          <div class="success-big-icon">
            ${
              successCount > 0
                ? "✓"
                : "!"
            }
          </div>

          <div class="eyebrow">
            ${
              processingCount
                ? "PUBLISHING IN PROGRESS"
                : "PUBLISHING COMPLETE"
            }
          </div>

          <h1>
            ${
              processingCount
                ? "Your publishing run is still processing."
                : "Your publishing run is finished."
            }
          </h1>

          <p>
            The system attempted to publish your content
            across ${results.length} selected Page${
              results.length === 1
                ? ""
                : "s"
            }.
          </p>

        </div>

        <div class="results-stats">

          <div class="result-stat success-stat">
            <span>Successful</span>
            <strong>
              ${successCount}
            </strong>
          </div>

          <div class="result-stat failed-stat">
            <span>Failed</span>
            <strong>
              ${failedCount}
            </strong>
          </div>

          <div class="result-stat total-stat">
            <span>Total</span>
            <strong>
              ${results.length}
            </strong>
          </div>

        </div>

        <section class="results-card">

          <div class="results-card-header">

            <div>
              <div class="eyebrow">
                PAGE RESULTS
              </div>

              <h2>
                Publishing Report
              </h2>
            </div>

            <div class="report-pill">
              ${successCount}/${results.length}
              successful
            </div>

          </div>

          <div class="results-list">
            ${resultsHtml}
          </div>

        </section>

        <div class="results-actions">

          <a
            class="back-btn"
            href="/"
          >
            <svg viewBox="0 0 24 24">
              <path d="M19 12H5"/>
              <path d="m11 18-6-6 6-6"/>
            </svg>
            Back to Dashboard
          </a>

        </div>

      </div>
    </div>
    `
  );
}

// =============================================================
// JSON RESPONSE
// =============================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        "Cache-Control":
          "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache"
      }
    }
  );
}

// =============================================================
// GRAPH API PUBLISHING
// =============================================================

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
      mediaName ||
        "image.jpg"
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
      mediaName ||
        "video.mp4"
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
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body
      }
    );

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
    await fetch(
      url,
      {
        method: "POST",
        body: form
      }
    );

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

// =============================================================
// GRAPH HELPERS
// =============================================================

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

function formatGraphError(
  data
) {
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
        ? "Type: " +
          e.type
        : "",

      e.code !== undefined
        ? "Code: " +
          e.code
        : "",

      e.error_subcode !==
      undefined
        ? "Subcode: " +
          e.error_subcode
        : ""
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return JSON.stringify(
    data
  );
}

// =============================================================
// UI HELPERS
// =============================================================

function getInitials(
  value
) {
  const text =
    String(
      value || ""
    ).trim();

  if (!text) {
    return "?";
  }

  const parts =
    text
      .split(/\s+/)
      .filter(Boolean);

  if (
    parts.length === 1
  ) {
    return parts[0]
      .slice(0, 2)
      .toUpperCase();
  }

  return (
    parts[0][0] +
    parts[
      parts.length - 1
    ][0]
  ).toUpperCase();
}

// =============================================================
// HTML PAGE
// =============================================================

function page(
  title,
  content
) {
  const css = `
* {
  box-sizing: border-box;
}

html {
  background: #07111f;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(
      circle at 20% 0%,
      rgba(37, 99, 235, 0.13),
      transparent 35%
    ),
    radial-gradient(
      circle at 85% 20%,
      rgba(14, 165, 233, 0.08),
      transparent 30%
    ),
    #07111f;
  color: #e8eef7;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

a {
  color: inherit;
  text-decoration: none;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.dashboard-header {
  position: relative;
  z-index: 20;
  border-bottom: 1px solid
    rgba(255,255,255,0.07);
  background:
    rgba(5, 13, 25, 0.88);
  backdrop-filter:
    blur(18px);
}

.header-inner {
  width: min(
    1380px,
    calc(100% - 48px)
  );
  margin: 0 auto;
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.brand-area,
.results-brand {
  display: flex;
  align-items: center;
  gap: 13px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background:
    linear-gradient(
      145deg,
      #1877f2,
      #0d5bd7
    );
  box-shadow:
    0 10px 28px
    rgba(24,119,242,0.28);
}

.brand-mark span {
  color: white;
  font-size: 25px;
  font-weight: 800;
  line-height: 1;
}

.brand-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.brand-name {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.brand-mini {
  color: #728198;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.connect-account-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 15px;
  border-radius: 10px;
  border: 1px solid
    rgba(255,255,255,0.08);
  background:
    rgba(255,255,255,0.04);
  color: #dfe8f4;
  font-size: 13px;
  font-weight: 700;
  transition:
    0.2s ease;
}

.connect-account-btn:hover {
  border-color:
    rgba(24,119,242,0.45);
  background:
    rgba(24,119,242,0.10);
}

.plus-icon {
  color: #69a8ff;
  font-size: 19px;
  line-height: 1;
}

.header-logout {
  border: 0;
  background: transparent;
  color: #8795a9;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 700;
}

.header-logout:hover {
  color: #ffffff;
}

.header-logout svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dashboard-container {
  width: min(
    1380px,
    calc(100% - 48px)
  );
  margin: 0 auto;
  padding: 56px 0 80px;
}

.hero {
  position: relative;
  overflow: hidden;
  min-height: 285px;
  padding: 50px;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 24px;
  background:
    linear-gradient(
      135deg,
      rgba(17,32,55,0.96),
      rgba(8,19,35,0.94)
    );
  box-shadow:
    0 25px 80px
    rgba(0,0,0,0.24);
}

.hero-glow {
  position: absolute;
  width: 430px;
  height: 430px;
  right: -120px;
  top: -210px;
  border-radius: 50%;
  background:
    rgba(24,119,242,0.15);
  filter: blur(5px);
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 780px;
}

.eyebrow {
  color: #5ea0ff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.2em;
}

.hero-eyebrow {
  margin-bottom: 14px;
}

.hero h1 {
  margin: 0;
  font-size: clamp(
    34px,
    4vw,
    58px
  );
  line-height: 1.04;
  letter-spacing: -0.04em;
}

.hero h1 span {
  display: block;
  color: #77b0ff;
}

.hero p {
  max-width: 690px;
  margin: 20px 0 0;
  color: #8797ad;
  font-size: 15px;
  line-height: 1.75;
}

.hero-decoration {
  position: absolute;
  right: 44px;
  bottom: 34px;
  z-index: 3;
}

.floating-card {
  min-width: 165px;
  padding: 13px 16px;
  border-radius: 13px;
  border: 1px solid
    rgba(255,255,255,0.08);
  background:
    rgba(7,17,31,0.72);
  box-shadow:
    0 18px 45px
    rgba(0,0,0,0.25);
  backdrop-filter:
    blur(15px);
  color: #7f8fa6;
  font-size: 11px;
  font-weight: 700;
}

.floating-card strong {
  display: block;
  margin-top: 3px;
  color: #eef5ff;
  font-size: 18px;
}

.floating-one {
  transform: translateX(-40px);
}

.floating-two {
  margin-top: -4px;
  transform: translateX(45px);
}

.mini-status,
.ready-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  background: #35d399;
  box-shadow:
    0 0 0 4px
    rgba(53,211,153,0.08);
}

.mini-facebook {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-right: 5px;
  border-radius: 5px;
  background: #1877f2;
  color: #fff;
  font-size: 12px;
  font-weight: 800;
}

.stats-grid {
  display: grid;
  grid-template-columns:
    repeat(3, 1fr);
  gap: 16px;
  margin-top: 18px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 125px;
  padding: 22px;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 18px;
  background:
    rgba(11,24,42,0.82);
}

.stat-icon {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  background:
    rgba(255,255,255,0.04);
}

.stat-icon svg {
  width: 23px;
  height: 23px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.accounts-icon {
  color: #69a8ff;
}

.pages-icon {
  color: #8cbcff;
}

.ready-icon {
  color: #53d6a1;
}

.stat-data {
  min-width: 0;
}

.stat-data span {
  display: block;
  color: #8190a4;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.stat-data strong {
  display: block;
  margin-top: 5px;
  color: #f1f6fd;
  font-size: 27px;
  line-height: 1;
}

.stat-data small {
  display: block;
  margin-top: 6px;
  color: #5f7087;
  font-size: 10px;
}

.account-card {
  margin-top: 18px;
  overflow: hidden;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 20px;
  background:
    rgba(10,23,40,0.88);
}

.account-top {
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 25px;
}

.account-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 15px;
}

.account-avatar {
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  background:
    linear-gradient(
      145deg,
      #1c80ff,
      #1056c5
    );
  color: #fff;
  font-weight: 800;
  box-shadow:
    0 12px 30px
    rgba(24,119,242,0.22);
}

.account-details {
  min-width: 0;
}

.account-name-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.account-name-line h2 {
  margin: 0;
  font-size: 17px;
}

.connected-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 999px;
  background:
    rgba(53,211,153,0.08);
  color: #62dca9;
  font-size: 9px;
  font-weight: 800;
}

.connected-badge span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #42d29a;
}

.facebook-id {
  margin-top: 6px;
  color: #63748a;
  font-size: 10px;
}

.facebook-id code {
  color: #8091a8;
}

.account-meta {
  margin-top: 9px;
  color: #63748a;
  font-size: 10px;
}

.account-meta strong {
  color: #b9c8da;
}

.account-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.account-actions form {
  margin: 0;
}

.action-btn {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid
    rgba(255,255,255,0.07);
  background:
    rgba(255,255,255,0.03);
  color: #a7b6c9;
  font-size: 11px;
  font-weight: 750;
}

.action-btn:hover {
  background:
    rgba(255,255,255,0.06);
  color: #fff;
}

.action-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.remove-btn:hover {
  color: #ff8795;
  border-color:
    rgba(255,91,107,0.25);
}

.pages-area {
  border-top: 1px solid
    rgba(255,255,255,0.055);
  padding: 0 24px 24px;
}

.page-toolbar {
  padding: 21px 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.toolbar-title {
  color: #dfe8f4;
  font-size: 12px;
  font-weight: 800;
}

.toolbar-subtitle {
  margin-top: 4px;
  color: #64758c;
  font-size: 10px;
}

.toolbar-actions {
  display: flex;
  gap: 7px;
}

.toolbar-btn {
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 8px;
  background:
    rgba(255,255,255,0.025);
  color: #8090a5;
  padding: 7px 10px;
  font-size: 10px;
  font-weight: 750;
}

.toolbar-btn:hover {
  color: #fff;
  background:
    rgba(255,255,255,0.06);
}

.page-list {
  display: grid;
  grid-template-columns:
    repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.page-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid
    rgba(255,255,255,0.055);
  border-radius: 11px;
  background:
    rgba(255,255,255,0.018);
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    transform 0.18s ease;
}

.page-row:hover {
  border-color:
    rgba(72,144,255,0.22);
  background:
    rgba(255,255,255,0.035);
}

.page-row.selected {
  border-color:
    rgba(70,143,255,0.34);
  background:
    rgba(24,119,242,0.07);
}

.page-row input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.custom-check {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: grid;
  place-items: center;
  border: 1px solid
    rgba(255,255,255,0.16);
  border-radius: 5px;
  background:
    rgba(255,255,255,0.025);
}

.custom-check svg {
  display: none;
  width: 13px;
  height: 13px;
  fill: none;
  stroke: #fff;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.page-row.selected
.custom-check {
  border-color: #3d91ff;
  background: #1877f2;
}

.page-row.selected
.custom-check svg {
  display: block;
}

.page-avatar {
  width: 35px;
  height: 35px;
  flex: 0 0 35px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background:
    rgba(255,255,255,0.06);
  color: #b9c9dd;
  font-size: 10px;
  font-weight: 800;
}

.page-info {
  min-width: 0;
  flex: 1;
}

.page-name {
  display: block;
  overflow: hidden;
  color: #d7e2ef;
  font-size: 11px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-id {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: #53657c;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-ready {
  color: #5cae91;
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.page-ready .ready-dot {
  width: 5px;
  height: 5px;
  margin-right: 4px;
}

.no-pages,
.empty-state {
  border: 1px dashed
    rgba(255,255,255,0.10);
  border-radius: 15px;
  background:
    rgba(255,255,255,0.018);
}

.no-pages {
  margin-top: 14px;
  padding: 18px;
  display: flex;
  align-items: center;
  gap: 13px;
}

.no-pages-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background:
    rgba(255,186,92,0.08);
  color: #e5b66d;
  font-weight: 800;
}

.no-pages strong {
  font-size: 11px;
}

.no-pages p {
  margin: 3px 0 0;
  color: #66778d;
  font-size: 10px;
}

.empty-state {
  margin-top: 18px;
  padding: 55px 30px;
  text-align: center;
}

.empty-icon {
  width: 58px;
  height: 58px;
  margin: 0 auto 17px;
  display: grid;
  place-items: center;
  border-radius: 17px;
  background:
    rgba(24,119,242,0.08);
  color: #6aa9ff;
}

.empty-icon svg {
  width: 27px;
  height: 27px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.empty-state h3 {
  margin: 8px 0;
  font-size: 19px;
}

.empty-state p {
  max-width: 480px;
  margin: 0 auto 22px;
  color: #68798f;
  font-size: 12px;
  line-height: 1.7;
}

.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 11px 16px;
  border-radius: 10px;
  background: #1877f2;
  color: white;
  font-size: 11px;
  font-weight: 800;
  box-shadow:
    0 10px 25px
    rgba(24,119,242,0.20);
}

.fb-symbol {
  font-size: 16px;
  font-weight: 900;
}

.studio-card {
  margin-top: 18px;
  padding: 27px;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 20px;
  background:
    rgba(10,23,40,0.90);
  box-shadow:
    0 25px 70px
    rgba(0,0,0,0.18);
}

.studio-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}

.studio-title-wrap {
  display: flex;
  align-items: center;
  gap: 14px;
}

.studio-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background:
    rgba(24,119,242,0.10);
  color: #6faaff;
}

.studio-icon svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.studio-heading h2 {
  margin: 4px 0 0;
  font-size: 20px;
  letter-spacing: -0.02em;
}

.studio-heading p {
  margin: 4px 0 0;
  color: #687a90;
  font-size: 10px;
}

.selected-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 11px;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 999px;
  color: #8c9db2;
  background:
    rgba(255,255,255,0.025);
  font-size: 10px;
  font-weight: 750;
}

.selected-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5c8ed1;
}

.composer-box {
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 13px;
  overflow: hidden;
  background:
    rgba(4,12,23,0.55);
}

.composer-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid
    rgba(255,255,255,0.05);
}

.composer-top label {
  color: #aebed1;
  font-size: 10px;
  font-weight: 800;
}

#char-count {
  color: #52647a;
  font-size: 9px;
}

.composer-box textarea {
  display: block;
  width: 100%;
  min-height: 165px;
  resize: vertical;
  border: 0;
  outline: 0;
  padding: 16px;
  background: transparent;
  color: #e9f0f8;
  font-size: 13px;
  line-height: 1.65;
}

.composer-box textarea::placeholder {
  color: #45566d;
}

.upload-box {
  position: relative;
  margin-top: 12px;
  min-height: 145px;
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed
    rgba(255,255,255,0.10);
  border-radius: 13px;
  background:
    rgba(255,255,255,0.015);
  cursor: pointer;
  text-align: center;
}

.upload-box:hover,
.upload-box.has-file {
  border-color:
    rgba(24,119,242,0.35);
  background:
    rgba(24,119,242,0.035);
}

.upload-box input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.upload-icon {
  width: 38px;
  height: 38px;
  margin-bottom: 8px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background:
    rgba(255,255,255,0.045);
  color: #7890ad;
}

.upload-icon svg {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.upload-title {
  color: #b8c8da;
  font-size: 11px;
  font-weight: 800;
}

.upload-subtitle {
  margin-top: 3px;
  color: #5d6f86;
  font-size: 9px;
}

.upload-hint {
  margin-top: 7px;
  color: #45566c;
  font-size: 8px;
}

.file-name {
  margin-top: 7px;
  color: #68a8ff;
  font-size: 9px;
  font-weight: 700;
}

.publish-footer {
  margin-top: 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
}

.publish-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.publish-info-icon {
  width: 31px;
  height: 31px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background:
    rgba(53,211,153,0.08);
  color: #53d49f;
  font-size: 13px;
  font-weight: 900;
}

.publish-info strong,
.publish-info span {
  display: block;
}

.publish-info strong {
  color: #aebed0;
  font-size: 10px;
}

.publish-info span {
  margin-top: 2px;
  color: #596b82;
  font-size: 9px;
}

.publish-btn {
  min-width: 190px;
  min-height: 43px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 0;
  border-radius: 10px;
  background:
    linear-gradient(
      135deg,
      #1877f2,
      #1162d5
    );
  color: #fff;
  font-size: 11px;
  font-weight: 850;
  box-shadow:
    0 12px 28px
    rgba(24,119,242,0.20);
}

.publish-btn:hover {
  filter: brightness(1.07);
}

.publish-btn:disabled {
  opacity: 0.7;
  cursor: wait;
}

.publish-arrow {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.publish-spinner {
  display: none;
  width: 15px;
  height: 15px;
  border: 2px solid
    rgba(255,255,255,0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation:
    spin 0.7s linear infinite;
}

.publish-btn.loading
.publish-spinner {
  display: inline-block;
}

.publish-btn.loading
.publish-arrow {
  display: none;
}

@keyframes spin {
  to {
    transform:
      rotate(360deg);
  }
}

.error-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 30px;
}

.error-box {
  width: min(
    620px,
    100%
  );
  padding: 32px;
  border: 1px solid
    rgba(255,255,255,0.08);
  border-radius: 18px;
  background:
    rgba(10,23,40,0.92);
}

.error-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background:
    rgba(255,91,107,0.09);
  color: #ff7c89;
  font-weight: 900;
  font-size: 18px;
}

.error-box h2 {
  margin: 9px 0;
}

.error-intro,
.error-detail {
  color: #77879b;
  font-size: 12px;
  line-height: 1.6;
}

.error-box pre {
  overflow: auto;
  max-height: 320px;
  margin-top: 18px;
  padding: 14px;
  border-radius: 10px;
  background:
    rgba(0,0,0,0.25);
  color: #d3deea;
  font-size: 10px;
  white-space: pre-wrap;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 15px;
  padding: 10px 14px;
  border-radius: 9px;
  background:
    rgba(255,255,255,0.05);
  color: #aab9ca;
  font-size: 10px;
  font-weight: 800;
}

.back-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.results-page {
  min-height: 100vh;
  background:
    radial-gradient(
      circle at 50% 0%,
      rgba(24,119,242,0.12),
      transparent 35%
    ),
    #07111f;
}

.results-topbar {
  min-height: 76px;
  padding: 0 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid
    rgba(255,255,255,0.06);
  background:
    rgba(5,13,25,0.84);
}

.small-mark {
  width: 38px;
  height: 38px;
  border-radius: 10px;
}

.small-mark span {
  font-size: 22px;
}

.results-container {
  width: min(
    1080px,
    calc(100% - 40px)
  );
  margin: 0 auto;
  padding: 50px 0 70px;
}

.results-hero {
  text-align: center;
}

.success-big-icon {
  width: 58px;
  height: 58px;
  margin: 0 auto 15px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background:
    rgba(53,211,153,0.09);
  color: #53d6a1;
  font-size: 25px;
  font-weight: 900;
}

.results-hero h1 {
  max-width: 700px;
  margin: 9px auto 0;
  font-size: clamp(
    28px,
    4vw,
    44px
  );
  letter-spacing: -0.035em;
}

.results-hero p {
  max-width: 600px;
  margin: 13px auto 0;
  color: #687a91;
  font-size: 12px;
  line-height: 1.7;
}

.results-stats {
  display: grid;
  grid-template-columns:
    repeat(3, 1fr);
  gap: 12px;
  margin-top: 30px;
}

.result-stat {
  padding: 17px;
  text-align: center;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 13px;
  background:
    rgba(11,24,42,0.75);
}

.result-stat span {
  display: block;
  color: #687a90;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.result-stat strong {
  display: block;
  margin-top: 5px;
  font-size: 24px;
}

.success-stat strong {
  color: #53d6a1;
}

.failed-stat strong {
  color: #ff7d89;
}

.total-stat strong {
  color: #83aef2;
}

.results-card {
  margin-top: 18px;
  overflow: hidden;
  border: 1px solid
    rgba(255,255,255,0.07);
  border-radius: 18px;
  background:
    rgba(10,23,40,0.88);
}

.results-card-header {
  padding: 21px 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  border-bottom: 1px solid
    rgba(255,255,255,0.055);
}

.results-card-header h2 {
  margin: 5px 0 0;
  font-size: 16px;
}

.report-pill {
  padding: 7px 10px;
  border-radius: 999px;
  background:
    rgba(255,255,255,0.035);
  color: #7e90a6;
  font-size: 9px;
  font-weight: 800;
}

.results-list {
  display: flex;
  flex-direction: column;
}

.result-row {
  min-height: 65px;
  padding: 12px 22px;
  display: grid;
  grid-template-columns:
    minmax(0, 1fr)
    auto
    minmax(130px, 0.45fr);
  align-items: center;
  gap: 18px;
  border-bottom: 1px solid
    rgba(255,255,255,0.045);
}

.result-row:last-child {
  border-bottom: 0;
}

.result-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
}

.result-avatar {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background:
    rgba(255,255,255,0.05);
  color: #9db0c8;
  font-size: 9px;
  font-weight: 850;
}

.result-main strong {
  display: block;
  overflow: hidden;
  color: #cbd8e7;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-page-id {
  margin-top: 3px;
  color: #53667e;
  font-size: 8px;
}

.result-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #74869d;
  font-size: 9px;
  font-weight: 800;
  white-space: nowrap;
}

.status-success {
  color: #58d5a2;
}

.status-failed {
  color: #ff7f8b;
}

.result-extra {
  overflow: hidden;
  color: #71839a;
  font-size: 8px;
  line-height: 1.5;
  text-overflow: ellipsis;
}

.success-extra {
  color: #536a7f;
}

.results-actions {
  display: flex;
  justify-content: center;
}

.results-actions .back-btn {
  margin-top: 22px;
}

@media (
  max-width: 900px
) {
  .hero-decoration {
    display: none;
  }

  .page-list {
    grid-template-columns:
      1fr;
  }

  .stats-grid {
    grid-template-columns:
      1fr;
  }
}

@media (
  max-width: 700px
) {
  .header-inner,
  .dashboard-container {
    width: min(
      100% - 28px,
      1380px
    );
  }

  .header-inner {
    min-height: 72px;
  }

  .connect-account-btn {
    display: none;
  }

  .dashboard-container {
    padding-top: 28px;
  }

  .hero {
    padding: 30px 23px;
    min-height: 0;
  }

  .account-top,
  .studio-heading,
  .publish-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .account-actions {
    width: 100%;
  }

  .account-actions form,
  .action-btn {
    flex: 1;
  }

  .studio-card {
    padding: 20px;
  }

  .publish-btn {
    width: 100%;
  }

  .results-stats {
    grid-template-columns:
      1fr;
  }

  .result-row {
    grid-template-columns:
      1fr auto;
  }

  .result-extra {
    grid-column: 1 / -1;
  }

  .results-topbar {
    padding: 0 18px;
  }
}
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <meta
    name="robots"
    content="noindex,nofollow"
  >
  <title>${escapeHtml(
    title
  )}</title>

  <style>
    ${css}
  </style>
</head>

<body>
  ${content}
</body>
</html>`;
}

// =============================================================
// AUTHENTICATION HELPERS
// =============================================================

async function handleLogin(
  request,
  env
) {
  const form =
    await request.formData();

  const password =
    String(
      form.get("password") || ""
    );

  const expected =
    String(
      env.PUBLISHER_PASSWORD || ""
    );

  if (
    !expected ||
    password !== expected
  ) {
    return showLoginPage(
      "Invalid password. Please try again."
    );
  }

  const sessionId =
    crypto.randomUUID();

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO auth_sessions " +
      "(id, created_at, dashboard_ticket) " +
      "VALUES (?, ?, 1)"
  )
    .bind(
      sessionId,
      now
    )
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        authCookie(sessionId),
      "Cache-Control": "no-store"
    }
  });
}

async function getAuthenticatedSession(
  request,
  env
) {
  const cookie =
    getCookie(
      request,
      "auth_session"
    );

  if (!cookie) {
    return null;
  }

  const session =
    await env.DB.prepare(
      "SELECT id, created_at, dashboard_ticket " +
        "FROM auth_sessions " +
        "WHERE id = ?"
    )
      .bind(cookie)
      .first();

  if (!session) {
    return null;
  }

  const createdAt =
    new Date(
      session.created_at
    ).getTime();

  if (
    !Number.isFinite(
      createdAt
    ) ||
    Date.now() -
      createdAt >
      24 * 60 * 60 * 1000
  ) {
    await deleteSession(
      env.DB,
      cookie
    );

    return null;
  }

  return {
    sessionId:
      session.id,
    dashboardTicket:
      Number(
        session.dashboard_ticket || 0
      )
  };
}

async function consumeDashboardTicket(
  db,
  sessionId
) {
  const result =
    await db.prepare(
      "UPDATE auth_sessions " +
        "SET dashboard_ticket = 0 " +
        "WHERE id = ? " +
        "AND dashboard_ticket = 1"
    )
      .bind(sessionId)
      .run();

  return Boolean(
    result &&
    result.meta &&
    result.meta.changes > 0
  );
}

async function allowNextDashboardLoad(
  db,
  sessionId
) {
  await db.prepare(
    "UPDATE auth_sessions " +
      "SET dashboard_ticket = 1 " +
      "WHERE id = ?"
  )
    .bind(sessionId)
    .run();
}

async function deleteSession(
  db,
  sessionId
) {
  if (!sessionId) {
    return;
  }

  await db.prepare(
    "DELETE FROM auth_sessions " +
      "WHERE id = ?"
  )
    .bind(sessionId)
    .run();
}

function authCookie(
  sessionId
) {
  return (
    "auth_session=" +
    encodeURIComponent(
      sessionId
    ) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400"
  );
}

function clearAuthCookie() {
  return (
    "auth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie":
        clearAuthCookie(),
      "Cache-Control":
        "no-store"
    }
  });
}

// =============================================================
// COOKIE HELPERS
// =============================================================

function getCookie(
  request,
  name
) {
  const header =
    request.headers.get(
      "Cookie"
    );

  if (!header) {
    return null;
  }

  const cookies =
    header.split(";");

  for (
    const cookie of cookies
  ) {
    const index =
      cookie.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      cookie
        .slice(0, index)
        .trim();

    if (key !== name) {
      continue;
    }

    return decodeURIComponent(
      cookie
        .slice(index + 1)
        .trim()
    );
  }

  return null;
}

// =============================================================
// HTML ESCAPING
// =============================================================

function escapeHtml(
  value
) {
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

// =============================================================
// LOGIN PAGE
// =============================================================

function showLoginPage(
  errorMessage
) {
  return page(
    "Login",
    `
    <div class="login-page">

      <div class="login-bg-glow"></div>

      <div class="login-card">

        <div class="login-brand">

          <div class="brand-mark login-mark">
            <span>f</span>
          </div>

          <div class="brand-name">
            NAQI SHAH
          </div>

          <div class="brand-mini">
            META PUBLISHING COMMAND CENTER
          </div>

        </div>

        <div class="login-heading">

          <div class="eyebrow">
            SECURE ACCESS
          </div>

          <h1>
            Welcome back.
          </h1>

          <p>
            Enter your password to access the
            Facebook publishing dashboard.
          </p>

        </div>

        ${
          errorMessage
            ? `
              <div class="login-error">
                ${escapeHtml(
                  errorMessage
                )}
              </div>
            `
            : ""
        }

        <form
          method="POST"
          action="/login"
          class="login-form"
        >

          <label
            for="password"
            class="login-label"
          >
            Dashboard Password
          </label>

          <div class="password-wrap">

            <input
              id="password"
              type="password"
              name="password"
              placeholder="Enter your password"
              autocomplete="current-password"
              required
              autofocus
            />

            <button
              type="button"
              class="show-password"
              onclick="togglePassword()"
              aria-label="Show password"
            >
              <svg
                id="eyeIcon"
                viewBox="0 0 24 24"
              >
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
                <circle
                  cx="12"
                  cy="12"
                  r="2.5"
                />
              </svg>
            </button>

          </div>

          <button
            type="submit"
            class="login-submit"
          >
            <span>
              Enter Dashboard
            </span>

            <svg viewBox="0 0 24 24">
              <path d="M5 12h14"/>
              <path d="m13 6 6 6-6 6"/>
            </svg>
          </button>

        </form>

        <div class="login-security">
          <span class="security-dot"></span>
          Protected dashboard session
        </div>

      </div>
    </div>

    <script>
      function togglePassword() {
        const input =
          document.getElementById(
            "password"
          );

        const icon =
          document.getElementById(
            "eyeIcon"
          );

        if (
          input.type ===
          "password"
        ) {
          input.type =
            "text";

          icon.innerHTML =
            '<path d="M3 3l18 18"/>' +
            '<path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>' +
            '<path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 3.8"/>' +
            '<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 3.1-.5"/>';
        } else {
          input.type =
            "password";

          icon.innerHTML =
            '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>' +
            '<circle cx="12" cy="12" r="2.5"/>';
        }
      }
    </script>
    `
  );
}
// =============================================================
// ESCAPE HTML
// =============================================================

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
