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
        if (
          request.method === "POST" &&
          (path === "/publish" || path === "/publish-batch")
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Your dashboard session has expired. Please log in again."
            },
            401
          );
        }

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

      if (
        request.method === "POST" &&
        (path === "/publish" || path === "/publish-batch")
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              error && error.message
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
    "Login",
    `
    <div class="login-shell">

      <div class="login-glow login-glow-one"></div>
      <div class="login-glow login-glow-two"></div>

      <div class="login-card">

        <div class="brand-mark">
          <div class="brand-mark-inner">
            N
          </div>
        </div>

        <div class="eyebrow">
          SECURE ACCESS
        </div>

        <h1>
          ${escapeHtml(APP_NAME)}
        </h1>

        <p class="login-subtitle">
          Enter your dashboard password to continue.
        </p>

        ${errorHtml}

        <form
          method="POST"
          action="/login"
          class="login-form"
        >

          <label
            class="field-label"
            for="password"
          >
            Dashboard Password
          </label>

          <div class="password-wrap">

            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              placeholder="Enter your password"
              required
              autofocus
            />

            <button
              type="button"
              class="password-toggle"
              onclick="togglePassword()"
              aria-label="Show or hide password"
            >
              <svg
                id="eyeIcon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
                <circle cx="12" cy="12" r="2.5"/>
              </svg>
            </button>

          </div>

          <button
            type="submit"
            class="login-submit"
          >
            <span>Unlock Dashboard</span>

            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12h14"/>
              <path d="m13 6 6 6-6 6"/>
            </svg>

          </button>

        </form>

        <div class="login-footer">

          <span class="status-dot"></span>

          <span>
            Protected publisher environment
          </span>

        </div>

        <div class="naqi-signature">
          NAQI SHAH
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

                <div class="account-label">
                  FACEBOOK ACCOUNT
                </div>

                <h3>
                  ${escapeHtml(
                    account.account_name ||
                      "Facebook Account"
                  )}
                </h3>

                <div class="account-id">
                  ID:
                  ${escapeHtml(
                    account.facebook_user_id
                  )}
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
                  value="${Number(
                    account.id
                  )}"
                />

                <button
                  class="secondary-btn"
                  type="submit"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 11a8.1 8.1 0 0 0-14.9-4"/>
                    <path d="M4 4v4h4"/>
                    <path d="M4 13a8.1 8.1 0 0 0 14.9 4"/>
                    <path d="M20 20v-4h-4"/>
                  </svg>

                  Sync Pages
                </button>
              </form>

              <form
                method="POST"
                action="/remove-account"
                onsubmit="return confirm(&quot;Remove this Facebook account and all its connected Pages?&quot;);"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${Number(
                    account.id
                  )}"
                />

                <button
                  class="danger-btn"
                  type="submit"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M3 6h18"/>
                    <path d="M8 6V4h8v2"/>
                    <path d="M19 6l-1 15H6L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                  </svg>

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

        <div class="brand-area">

          <div class="brand-icon">
            N
          </div>

          <div class="brand-copy">

            <div class="brand-name">
              ${escapeHtml(APP_NAME)}
            </div>

            <div class="brand-byline">
              POWERED BY
              <strong>NAQI SHAH</strong>
            </div>

          </div>

        </div>

        <div class="topbar-actions">

          <div class="live-status">
            <span class="live-dot"></span>
            SYSTEM ONLINE
          </div>

          <a
            href="/logout"
            class="logout-btn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M10 17l5-5-5-5"/>
              <path d="M15 12H3"/>
              <path d="M21 19V5a2 2 0 0 0-2-2h-6"/>
            </svg>

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
              Manage your
              <span>Facebook Pages</span>
              from one place.
            </h1>

            <p>
              Connect multiple Facebook accounts,
              select your Pages and publish content
              across your network with ease.
            </p>

          </div>

          <div class="hero-stats">

            <div class="stat-card">

              <div class="stat-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
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
                ACCOUNTS
              </div>

            </div>

            <div class="stat-card">

              <div class="stat-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect
                    x="3"
                    y="4"
                    width="18"
                    height="16"
                    rx="3"
                  />
                  <path d="M7 8h10"/>
                  <path d="M7 12h6"/>
                  <path d="M7 16h8"/>
                </svg>
              </div>

              <div class="stat-value">
                ${totalPages}
              </div>

              <div class="stat-label">
                PAGES
              </div>

            </div>

          </div>

        </section>

        <section class="section-heading">

          <div>

            <div class="eyebrow">
              CONNECTED ACCOUNTS
            </div>

            <h2>
              Your publishing network
            </h2>

          </div>

          <a
            href="/auth/meta"
            class="primary-btn small"
          >
            <span class="fb-symbol">f</span>
            Add Facebook Account
          </a>

        </section>

        <div class="accounts-container">
          ${accountHtml}
        </div>

        <section class="publisher-section">

          <div class="publisher-heading">

            <div>

              <div class="eyebrow">
                CONTENT PUBLISHER
              </div>

              <h2>
                Create a new post
              </h2>

              <p>
                Select one or more Pages above,
                write your content and publish.
              </p>

            </div>

            <div class="publisher-badge">
              <span class="ready-dot"></span>
              READY TO PUBLISH
            </div>

          </div>

          <form
            id="publish-form"
            class="publish-form"
            enctype="multipart/form-data"
          >

            <div class="form-grid">

              <div class="message-field">

                <label
                  for="message"
                  class="field-label"
                >
                  Post Message
                </label>

                <textarea
                  id="message"
                  name="message"
                  rows="8"
                  placeholder="Write something to publish across your selected Pages..."
                ></textarea>

                <div class="field-meta">
                  <span>
                    Your message will be sent to each selected Page.
                  </span>

                  <span id="charCount">
                    0 characters
                  </span>
                </div>

              </div>

              <div class="media-field">

                <label class="field-label">
                  Media
                  <span class="optional">
                    OPTIONAL
                  </span>
                </label>

                <label
                  class="upload-zone"
                  for="media"
                >

                  <input
                    id="media"
                    name="media"
                    type="file"
                    accept="image/*,video/*"
                  />

                  <div class="upload-icon">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M12 16V4"/>
                      <path d="m7 9 5-5 5 5"/>
                      <path d="M5 20h14"/>
                    </svg>
                  </div>

                  <strong>
                    Click to upload media
                  </strong>

                  <span>
                    Images and videos supported
                  </span>

                  <small>
                    Maximum file size depends on Meta limits.
                  </small>

                </label>

                <div
                  id="fileInfo"
                  class="file-info hidden"
                ></div>

              </div>

            </div>

            <div class="publish-footer">

              <div class="selection-summary">

                <span class="selection-icon">
                  ✓
                </span>

                <span>
                  <strong id="selectedCount">
                    0
                  </strong>
                  Pages selected
                </span>

              </div>

              <button
                type="submit"
                id="publishButton"
                class="publish-btn"
              >

                <span
                  id="publishButtonText"
                >
                  Publish Now
                </span>

                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M22 2 11 13"/>
                  <path d="m22 2-7 20-4-9-9-4Z"/>
                </svg>

              </button>

            </div>

          </form>

          <div
            id="publishStatus"
            class="publish-status hidden"
          ></div>

        </section>

      </main>

      <footer class="dashboard-footer">

        <div>
          ${escapeHtml(APP_NAME)}
        </div>

        <div>
          Crafted for
          <strong>NAQI SHAH</strong>
        </div>

      </footer>

    </div>

    <script>
      const messageInput =
        document.getElementById("message");

      const charCount =
        document.getElementById("charCount");

      const mediaInput =
        document.getElementById("media");

      const fileInfo =
        document.getElementById("fileInfo");

      const selectedCount =
        document.getElementById("selectedCount");

      const publishForm =
        document.getElementById("publish-form");

      const publishButton =
        document.getElementById("publishButton");

      const publishButtonText =
        document.getElementById(
          "publishButtonText"
        );

      const publishStatus =
        document.getElementById(
          "publishStatus"
        );

      const PUBLISH_BATCH_SIZE = 15;

      if (messageInput) {
        messageInput.addEventListener(
          "input",
          function () {
            charCount.textContent =
              this.value.length +
              " characters";
          }
        );
      }

      if (mediaInput) {
        mediaInput.addEventListener(
          "change",
          function () {
            const file =
              this.files &&
              this.files.length
                ? this.files[0]
                : null;

            if (!file) {
              fileInfo.classList.add(
                "hidden"
              );

              fileInfo.innerHTML = "";

              return;
            }

            fileInfo.classList.remove(
              "hidden"
            );

            fileInfo.innerHTML =
              '<strong>' +
              escapeClientHtml(
                file.name
              ) +
              '</strong><span>' +
              formatClientBytes(
                file.size
              ) +
              '</span>';
          }
        );
      }

      function updateSelectedCount() {
        const checked =
          document.querySelectorAll(
            '.page-checkbox:checked'
          );

        selectedCount.textContent =
          checked.length;
      }

      document.addEventListener(
        "change",
        function (event) {
          if (
            event.target &&
            event.target.classList &&
            event.target.classList.contains(
              "page-checkbox"
            )
          ) {
            updateSelectedCount();
          }
        }
      );

      function selectAccountPages(
        accountId,
        shouldSelect
      ) {
        const boxes =
          document.querySelectorAll(
            ".account-" +
              Number(accountId)
          );

        boxes.forEach(function (box) {
          box.checked =
            !!shouldSelect;
        });

        updateSelectedCount();
      }

      function escapeClientHtml(value) {
        return String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function formatClientBytes(
        bytes
      ) {
        const n =
          Number(bytes || 0);

        if (n < 1024) {
          return n + " B";
        }

        if (n < 1024 * 1024) {
          return (
            (n / 1024).toFixed(1) +
            " KB"
          );
        }

        if (
          n <
          1024 * 1024 * 1024
        ) {
          return (
            (n /
              (1024 * 1024)
            ).toFixed(1) +
            " MB"
          );
        }

        return (
          (n /
            (1024 *
              1024 *
              1024)
          ).toFixed(1) +
          " GB"
        );
      }

      async function readJsonResponse(
        response,
        fallbackMessage
      ) {
        const text =
          await response.text();

        try {
          return JSON.parse(text);
        } catch (error) {
          if (
            response.redirected ||
            response.url.includes(
              "/login"
            )
          ) {
            throw new Error(
              "Your dashboard session has expired. Please log in again."
            );
          }

          throw new Error(
            fallbackMessage +
            " Server returned an unexpected response (HTTP " +
            response.status +
            ")."
          );
        }
      }

      publishForm.addEventListener(
        "submit",
        async function (event) {
          event.preventDefault();

          const checked =
            Array.from(
              document.querySelectorAll(
                '.page-checkbox:checked'
              )
            );

          if (!checked.length) {
            showPublishStatus(
              "error",
              "Please select at least one Facebook Page."
            );

            return;
          }

          const message =
            String(
              messageInput.value || ""
            ).trim();

          const media =
            mediaInput &&
            mediaInput.files &&
            mediaInput.files.length
              ? mediaInput.files[0]
              : null;

          if (
            !message &&
            !media
          ) {
            showPublishStatus(
              "error",
              "Please enter a message or select a media file."
            );

            return;
          }

          publishButton.disabled =
            true;

          publishButtonText.textContent =
            "Preparing...";

          publishStatus.className =
            "publish-status";

          publishStatus.innerHTML =
            '<div class="status-spinner"></div>' +
            '<div><strong>Preparing publish run...</strong>' +
            '<span>Creating your publishing batch.</span></div>';

          try {
            const formData =
              new FormData();

            formData.append(
              "message",
              message
            );

            checked.forEach(
              function (checkbox) {
                formData.append(
                  "page_ids",
                  checkbox.value
                );
              }
            );

            if (media) {
              formData.append(
                "media",
                media
              );
            }

            const startResponse =
              await fetch(
                "/publish",
                {
                  method: "POST",
                  body: formData,
                  credentials: "same-origin"
                }
              );

            const startResult =
              await readJsonResponse(
                startResponse,
                "Could not start publishing."
              );

            if (
              !startResult ||
              !startResult.ok
            ) {
              throw new Error(
                startResult &&
                startResult.error
                  ? startResult.error
                  : "Could not start publishing."
              );
            }

            const runId =
              startResult.runId;

            const total =
              Number(
                startResult.total || 0
              );

            let processed = 0;
            let succeeded = 0;
            let failed = 0;

            while (
              processed < total
            ) {
              publishButtonText.textContent =
                "Publishing " +
                Math.min(
                  processed +
                    PUBLISH_BATCH_SIZE,
                  total
                ) +
                " / " +
                total;

              publishStatus.className =
                "publish-status";

              publishStatus.innerHTML =
                '<div class="status-spinner"></div>' +
                '<div><strong>Publishing...</strong>' +
                '<span>' +
                processed +
                ' of ' +
                total +
                ' Pages processed.</span></div>';

              const batchResponse =
                await fetch(
                  "/publish-batch",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        "application/json"
                    },
                    credentials:
                      "same-origin",
                    body: JSON.stringify({
                      runId
                    })
                  }
                );

              const batchResult =
                await readJsonResponse(
                  batchResponse,
                  "A publishing batch failed."
                );

              if (
                !batchResult ||
                !batchResult.ok
              ) {
                throw new Error(
                  batchResult &&
                  batchResult.error
                    ? batchResult.error
                    : "A publishing batch failed."
                );
              }

              processed =
                Number(
                  batchResult.processed ||
                    processed
                );

              succeeded +=
                Number(
                  batchResult.succeeded ||
                    0
                );

              failed +=
                Number(
                  batchResult.failed ||
                    0
                );

              if (
                batchResult.done
              ) {
                break;
              }
            }

            publishButtonText.textContent =
              "Publish Complete";

            publishStatus.className =
              "publish-status success";

            publishStatus.innerHTML =
              '<div class="status-success-icon">✓</div>' +
              '<div><strong>Publishing completed</strong>' +
              '<span>' +
              succeeded +
              ' successful, ' +
              failed +
              ' failed.</span></div>';

            setTimeout(
              function () {
                window.location.href =
                  "/publish-results?runId=" +
                  encodeURIComponent(
                    runId
                  );
              },
              900
            );
          } catch (error) {
            console.error(
              error
            );

            publishButton.disabled =
              false;

            publishButtonText.textContent =
              "Publish Now";

            showPublishStatus(
              "error",
              error &&
              error.message
                ? error.message
                : String(error)
            );
          }
        }
      );

      function showPublishStatus(
        type,
        message
      ) {
        publishStatus.className =
          "publish-status " +
          (type === "error"
            ? "error"
            : "success");

        publishStatus.innerHTML =
          '<div class="status-message-icon">' +
          (type === "error"
            ? "!"
            : "✓") +
          '</div><div>' +
          '<strong>' +
          (type === "error"
            ? "Unable to publish"
            : "Done") +
          '</strong>' +
          '<span>' +
          escapeClientHtml(
            message
          ) +
          '</span></div>';
      }

      updateSelectedCount();
    </script>
    `
  );
}

// =============================================================
// META LOGIN
// =============================================================

async function startMetaLogin(
  request,
  env,
  sessionId
) {
  const config = getMetaConfig(env);

  const requestUrl = new URL(request.url);

  const redirectUri =
    requestUrl.origin +
    "/auth/meta/callback";

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const state =
    crypto.randomUUID();

  await env.DB.prepare(
    "UPDATE auth_sessions " +
      "SET meta_state = ? " +
      "WHERE id = ?"
  )
    .bind(
      state,
      sessionId
    )
    .run();

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
    encodeURIComponent(state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: loginUrl,
      "Cache-Control": "no-store"
    }
  });
}

// META CALLBACK
// =============================================================

async function metaCallback(
  request,
  env,
  sessionId
) {
  const url =
    new URL(request.url);

  const code =
    url.searchParams.get(
      "code"
    );

  const state =
    url.searchParams.get(
      "state"
    );

  const error =
    url.searchParams.get(
      "error"
    );

  const errorReason =
    url.searchParams.get(
      "error_reason"
    );

  const errorDescription =
    url.searchParams.get(
      "error_description"
    );

  if (error) {
    return page(
      "Facebook Login Cancelled",
      `
      <div class="error-screen">
        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            FACEBOOK LOGIN
          </div>

          <h2>
            Facebook connection was cancelled
          </h2>

          <p class="error-intro">
            ${
              escapeHtml(
                errorDescription ||
                  errorReason ||
                  error
              )
            }
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
    return page(
      "Facebook Login Error",
      `
      <div class="error-screen">
        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            FACEBOOK LOGIN
          </div>

          <h2>
            Authorization code missing
          </h2>

          <p class="error-intro">
            Facebook did not return a valid authorization code.
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

  const session =
    await env.DB.prepare(
      "SELECT id, meta_state " +
        "FROM auth_sessions " +
        "WHERE id = ?"
    )
      .bind(sessionId)
      .first();

  if (!session) {
    return page(
      "Session Expired",
      `
      <div class="error-screen">
        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            SESSION
          </div>

          <h2>
            Your session has expired
          </h2>

          <p class="error-intro">
            Please log in again and reconnect Facebook.
          </p>

          <a
            class="back-btn"
            href="/login"
          >
            Login Again
          </a>

        </div>
      </div>
      `
    );
  }

  if (
    !state ||
    !session.meta_state ||
    state !== session.meta_state
  ) {
    return page(
      "Invalid OAuth State",
      `
      <div class="error-screen">
        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            SECURITY CHECK
          </div>

          <h2>
            Invalid authorization state
          </h2>

          <p class="error-intro">
            The Facebook authorization could not be verified.
            Please start the connection again.
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

  await env.DB.prepare(
    "UPDATE auth_sessions " +
      "SET meta_state = NULL " +
      "WHERE id = ?"
  )
    .bind(sessionId)
    .run();

  try {
    const config =
      getMetaConfig(env);

    const redirectUri =
      url.origin +
      "/auth/meta/callback";

    // ---------------------------------------------------------
    // EXCHANGE AUTHORIZATION CODE FOR USER ACCESS TOKEN
    // ---------------------------------------------------------

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
      await fetch(
        tokenUrl,
        {
          method: "GET"
        }
      );

    const tokenData =
      await tokenResponse.json();

    if (
      !tokenResponse.ok ||
      !tokenData.access_token
    ) {
      throw new Error(
        "Facebook token exchange failed: " +
          (
            tokenData.error &&
            tokenData.error.message
              ? tokenData.error.message
              : JSON.stringify(
                  tokenData
                )
          )
      );
    }

    const shortLivedToken =
      tokenData.access_token;

    // ---------------------------------------------------------
    // EXCHANGE FOR LONG-LIVED USER TOKEN
    // ---------------------------------------------------------

    const longTokenUrl =
      "https://graph.facebook.com/" +
      config.graphVersion +
      "/oauth/access_token" +
      "?grant_type=fb_exchange_token" +
      "&client_id=" +
      encodeURIComponent(
        config.appId
      ) +
      "&client_secret=" +
      encodeURIComponent(
        config.appSecret
      ) +
      "&fb_exchange_token=" +
      encodeURIComponent(
        shortLivedToken
      );

    const longTokenResponse =
      await fetch(
        longTokenUrl,
        {
          method: "GET"
        }
      );

    const longTokenData =
      await longTokenResponse.json();

    if (
      !longTokenResponse.ok ||
      !longTokenData.access_token
    ) {
      throw new Error(
        "Facebook long-lived token exchange failed: " +
          (
            longTokenData.error &&
            longTokenData.error.message
              ? longTokenData.error.message
              : JSON.stringify(
                  longTokenData
                )
          )
      );
    }

    const accessToken =
      longTokenData.access_token;

    // ---------------------------------------------------------
    // GET FACEBOOK USER INFORMATION
    // ---------------------------------------------------------

    const meUrl =
      "https://graph.facebook.com/" +
      config.graphVersion +
      "/me" +
      "?fields=id,name" +
      "&access_token=" +
      encodeURIComponent(
        accessToken
      );

    const meResponse =
      await fetch(
        meUrl
      );

    const meData =
      await meResponse.json();

    if (
      !meResponse.ok ||
      !meData.id
    ) {
      throw new Error(
        "Could not retrieve Facebook account information: " +
          (
            meData.error &&
            meData.error.message
              ? meData.error.message
              : JSON.stringify(
                  meData
                )
          )
      );
    }

    // ---------------------------------------------------------
    // SAVE / UPDATE ACCOUNT
    // ---------------------------------------------------------

    await env.DB.prepare(
      "INSERT INTO accounts " +
        "(facebook_user_id, account_name, access_token) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT(facebook_user_id) DO UPDATE SET " +
        "account_name = excluded.account_name, " +
        "access_token = excluded.access_token"
    )
      .bind(
        meData.id,
        meData.name ||
          "Facebook Account",
        accessToken
      )
      .run();

    const account =
      await env.DB.prepare(
        "SELECT id, facebook_user_id, account_name, access_token " +
          "FROM accounts " +
          "WHERE facebook_user_id = ?"
      )
        .bind(meData.id)
        .first();

    if (!account) {
      throw new Error(
        "Facebook account could not be saved."
      );
    }

    // ---------------------------------------------------------
    // SYNC PAGES
    // ---------------------------------------------------------

    const syncResult =
      await syncAccount(
        env,
        account
      );

    await allowNextDashboardLoad(
      env.DB,
      sessionId
    );

    return page(
      "Facebook Connected",
      `
      <div class="success-screen">

        <div class="success-box">

          <div class="success-icon">
            ✓
          </div>

          <div class="eyebrow">
            CONNECTION SUCCESSFUL
          </div>

          <h2>
            Facebook account connected
          </h2>

          <p class="success-intro">
            ${escapeHtml(
              meData.name ||
                "Facebook Account"
            )}
            is now connected to your publishing dashboard.
          </p>

          <div class="success-stats">

            <div>
              <strong>
                ${Number(
                  syncResult.count || 0
                )}
              </strong>

              <span>
                Pages synced
              </span>
            </div>

          </div>

          <a
            class="back-btn success-back"
            href="/"
          >
            Open Dashboard
          </a>

        </div>

      </div>
      `
    );
  } catch (error) {
    console.error(
      "Meta callback error:",
      error
    );

    await allowNextDashboardLoad(
      env.DB,
      sessionId
    );

    return page(
      "Facebook Connection Error",
      `
      <div class="error-screen">
        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            FACEBOOK CONNECTION
          </div>

          <h2>
            Connection failed
          </h2>

          <p class="error-intro">
            ${escapeHtml(
              error &&
              error.message
                ? error.message
                : String(error)
            )}
          </p>

          <a
            class="back-btn"
            href="/"
          >
            Return to Dashboard
          </a>

        </div>
      </div>
      `
    );
  }
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

  if (
    !Number.isFinite(
      accountId
    ) ||
    accountId <= 0
  ) {
    return redirectPage(
      "/",
      "Invalid Facebook account."
    );
  }

  const account =
    await env.DB.prepare(
      "SELECT id, facebook_user_id, account_name, access_token " +
        "FROM accounts WHERE id = ?"
    )
      .bind(accountId)
      .first();

  if (!account) {
    return redirectPage(
      "/",
      "Facebook account not found."
    );
  }

  try {
    const result =
      await syncAccount(
        env,
        account
      );

    return redirectPage(
      "/",
      "Successfully synced " +
        Number(
          result.count || 0
        ) +
        " Facebook Pages."
    );
  } catch (error) {
    console.error(
      "Sync error:",
      error
    );

    return redirectPage(
      "/",
      "Page sync failed: " +
        (
          error &&
          error.message
            ? error.message
            : String(error)
        )
    );
  }
}

async function syncAccount(
  env,
  account
) {
  const config =
    getMetaConfig(env);

  let url =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/" +
    encodeURIComponent(
      account.facebook_user_id
    ) +
    "/accounts" +
    "?fields=id,name,access_token" +
    "&limit=100" +
    "&access_token=" +
    encodeURIComponent(
      account.access_token
    );

  const pages = [];

  while (url) {
    const response =
      await fetch(url);

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        "Facebook Pages request failed: " +
          (
            data.error &&
            data.error.message
              ? data.error.message
              : JSON.stringify(
                  data
                )
          )
      );
    }

    if (
      Array.isArray(
        data.data
      )
    ) {
      pages.push(
        ...data.data
      );
    }

    url =
      data.paging &&
      data.paging.next
        ? data.paging.next
        : null;
  }

  // ---------------------------------------------------------
  // REPLACE THE ACCOUNT'S PAGE LIST
  // ---------------------------------------------------------

  await env.DB.prepare(
    "DELETE FROM pages WHERE account_id = ?"
  )
    .bind(account.id)
    .run();

  for (const fbPage of pages) {
    if (
      !fbPage ||
      !fbPage.id ||
      !fbPage.access_token
    ) {
      continue;
    }

    await env.DB.prepare(
      "INSERT INTO pages " +
        "(facebook_page_id, page_name, access_token, account_id) " +
        "VALUES (?, ?, ?, ?)"
    )
      .bind(
        String(
          fbPage.id
        ),
        String(
          fbPage.name ||
            "Facebook Page"
        ),
        String(
          fbPage.access_token
        ),
        account.id
      )
      .run();
  }

  return {
    ok: true,
    count: pages.length
  };
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

  if (
    !Number.isFinite(
      accountId
    ) ||
    accountId <= 0
  ) {
    return redirectPage(
      "/",
      "Invalid Facebook account."
    );
  }

  const account =
    await env.DB.prepare(
      "SELECT id, account_name " +
        "FROM accounts " +
        "WHERE id = ?"
    )
      .bind(accountId)
      .first();

  if (!account) {
    return redirectPage(
      "/",
      "Facebook account not found."
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

  return redirectPage(
    "/",
    "Facebook account removed successfully."
  );
}

// =============================================================
// START PUBLISH RUN
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

  const pageIds =
    form
      .getAll("page_ids")
      .map(
        function(value) {
          return Number(
            value
          );
        }
      )
      .filter(
        function(value) {
          return (
            Number.isFinite(
              value
            ) &&
            value > 0
          );
        }
      );

  const media =
    form.get("media");

  if (!pageIds.length) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Please select at least one Facebook Page."
      },
      400
    );
  }

  if (
    !message &&
    !isValidMediaFile(media)
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Please enter post text or select an image/video."
      },
      400
    );
  }

  if (
    pageIds.length >
    1000
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Too many Pages selected. Please select fewer Pages."
      },
      400
    );
  }

  const placeholders =
    pageIds
      .map(
        function() {
          return "?";
        }
      )
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, access_token " +
        "FROM pages " +
        "WHERE id IN (" +
        placeholders +
        ") " +
        "ORDER BY id ASC"
    )
      .bind(...pageIds)
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    return jsonResponse(
      {
        ok: false,
        error:
          "None of the selected Pages could be found."
      },
      400
    );
  }

  const runId =
    crypto.randomUUID();

  let mediaType = null;
  let mediaName = null;

  if (
    isValidMediaFile(media)
  ) {
    mediaType =
      media.type || null;

    mediaName =
      media.name || null;
  }

  await env.DB.prepare(
    "INSERT INTO publish_runs " +
      "(id, session_id, message, media_type, media_name, created_at, status) " +
      "VALUES (?, ?, ?, ?, ?, datetime('now'), 'processing')"
  )
    .bind(
      runId,
      sessionId,
      message,
      mediaType,
      mediaName
    )
    .run();

  for (const p of pages) {
    await env.DB.prepare(
      "INSERT INTO publish_run_pages " +
        "(run_id, page_db_id, facebook_page_id, page_name, status, created_at) " +
        "VALUES (?, ?, ?, ?, 'pending', datetime('now'))"
    )
      .bind(
        runId,
        p.id,
        p.facebook_page_id,
        p.page_name ||
          "Facebook Page"
      )
      .run();
  }

  return jsonResponse({
    ok: true,
    runId,
    total: pages.length
  });
}

// =============================================================
// PROCESS PUBLISH BATCH
// =============================================================

async function processPublishBatch(
  request,
  env,
  sessionId
) {
  const contentType =
    request.headers.get(
      "Content-Type"
    ) || "";

  let runId = "";
  let requestedPageIds = [];

  if (
    contentType
      .toLowerCase()
      .includes(
        "application/json"
      )
  ) {
    const body =
      await request.json();

    runId =
      String(
        body.runId ||
          body.run_id ||
          ""
      ).trim();

    requestedPageIds =
      Array.isArray(
        body.page_ids
      )
        ? body.page_ids
            .map(
              function(value) {
                return Number(
                  value
                );
              }
            )
            .filter(
              function(value) {
                return (
                  Number.isFinite(
                    value
                  ) &&
                  value > 0
                );
              }
            )
        : [];
  } else {
    const form =
      await request.formData();

    runId =
      String(
        form.get("run_id") ||
          form.get("runId") ||
          ""
      ).trim();

    requestedPageIds =
      form
        .getAll("page_ids")
        .map(
          function(value) {
            return Number(
              value
            );
          }
        )
        .filter(
          function(value) {
            return (
              Number.isFinite(
                value
              ) &&
              value > 0
            );
          }
        );
  }

  if (!runId) {
    return jsonResponse(
      {
        ok: false,
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
        ok: false,
        error:
          "Publishing run was not found."
      },
      404
    );
  }

  if (
    run.session_id !==
    sessionId
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "You are not authorized to process this publishing run."
      },
      403
    );
  }

  if (
    run.status ===
    "completed"
  ) {
    const counts =
      await getPublishRunCounts(
        env.DB,
        runId
      );

    return jsonResponse({
      ok: true,
      done: true,
      processed:
        counts.total,
      succeeded:
        counts.succeeded,
      failed:
        counts.failed
    });
  }

  let batchRows;

  if (
    requestedPageIds.length
  ) {
    const placeholders =
      requestedPageIds
        .map(
          function() {
            return "?";
          }
        )
        .join(",");

    const result =
      await env.DB.prepare(
        "SELECT " +
          "prp.id, " +
          "prp.page_db_id, " +
          "prp.facebook_page_id, " +
          "prp.page_name, " +
          "p.access_token " +
          "FROM publish_run_pages prp " +
          "INNER JOIN pages p " +
          "ON p.id = prp.page_db_id " +
          "WHERE prp.run_id = ? " +
          "AND prp.status = 'pending' " +
          "AND prp.page_db_id IN (" +
          placeholders +
          ") " +
          "ORDER BY prp.id ASC " +
          "LIMIT 15"
      )
        .bind(
          runId,
          ...requestedPageIds
        )
        .all();

    batchRows =
      result.results || [];
  } else {
    const result =
      await env.DB.prepare(
        "SELECT " +
          "prp.id, " +
          "prp.page_db_id, " +
          "prp.facebook_page_id, " +
          "prp.page_name, " +
          "p.access_token " +
          "FROM publish_run_pages prp " +
          "INNER JOIN pages p " +
          "ON p.id = prp.page_db_id " +
          "WHERE prp.run_id = ? " +
          "AND prp.status = 'pending' " +
          "ORDER BY prp.id ASC " +
          "LIMIT 15"
      )
        .bind(runId)
        .all();

    batchRows =
      result.results || [];
  }

  if (!batchRows.length) {
    const counts =
      await getPublishRunCounts(
        env.DB,
        runId
      );

    const done =
      counts.pending === 0;

    if (done) {
      await env.DB.prepare(
        "UPDATE publish_runs " +
          "SET status = 'completed', " +
          "completed_at = datetime('now') " +
          "WHERE id = ?"
      )
        .bind(runId)
        .run();
    }

    return jsonResponse({
      ok: true,
      done,
      processed:
        counts.succeeded +
        counts.failed,
      succeeded:
        counts.succeeded,
      failed:
        counts.failed
    });
  }

  const bodyMedia =
    contentType
      .toLowerCase()
      .includes(
        "application/json"
      )
      ? null
      : await getMediaFromFormRequest(
          request
        );

  const results = [];

  for (const row of batchRows) {
    try {
      const result =
        await publishToPage(
          env,
          row,
          run.message || "",
          bodyMedia
        );

      await env.DB.prepare(
        "UPDATE publish_run_pages " +
          "SET status = 'success', " +
          "post_id = ?, " +
          "error = NULL, " +
          "completed_at = datetime('now') " +
          "WHERE id = ?"
      )
        .bind(
          result.postId ||
            null,
          row.id
        )
        .run();

      results.push({
        pageId:
          row.facebook_page_id,
        pageName:
          row.page_name,
        ok: true,
        postId:
          result.postId ||
          null
      });
    } catch (error) {
      const message =
        error &&
        error.message
          ? error.message
          : String(error);

      await env.DB.prepare(
        "UPDATE publish_run_pages " +
          "SET status = 'failed', " +
          "error = ?, " +
          "completed_at = datetime('now') " +
          "WHERE id = ?"
      )
        .bind(
          message,
          row.id
        )
        .run();

      results.push({
        pageId:
          row.facebook_page_id,
        pageName:
          row.page_name,
        ok: false,
        error: message
      });
    }
  }

  const counts =
    await getPublishRunCounts(
      env.DB,
      runId
    );

  const done =
    counts.pending === 0;

  if (done) {
    await env.DB.prepare(
      "UPDATE publish_runs " +
        "SET status = 'completed', " +
        "completed_at = datetime('now') " +
        "WHERE id = ?"
    )
      .bind(runId)
      .run();
  }

  return jsonResponse({
    ok: true,
    done,
    processed:
      counts.succeeded +
      counts.failed,
    succeeded:
      counts.succeeded,
    failed:
      counts.failed,
    results
  });
}



//PART 3
// =============================================================
// PUBLISH RUN COUNTS
// =============================================================

async function getPublishRunCounts(
  db,
  runId
) {
  const result =
    await db.prepare(
      "SELECT " +
        "COUNT(*) AS total, " +
        "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, " +
        "SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded, " +
        "SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed " +
        "FROM publish_run_pages " +
        "WHERE run_id = ?"
    )
      .bind(runId)
      .first();

  return {
    total: Number(
      result &&
        result.total
        ? result.total
        : 0
    ),

    pending: Number(
      result &&
        result.pending
        ? result.pending
        : 0
    ),

    succeeded: Number(
      result &&
        result.succeeded
        ? result.succeeded
        : 0
    ),

    failed: Number(
      result &&
        result.failed
        ? result.failed
        : 0
    )
  };
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
        "runId"
      ) ||
        url.searchParams.get(
          "run_id"
        ) ||
        ""
    ).trim();

  if (!runId) {
    return redirectPage(
      "/",
      "Publishing run ID is missing."
    );
  }

  const run =
    await env.DB.prepare(
      "SELECT id, session_id, message, media_type, media_name, created_at, completed_at, status " +
        "FROM publish_runs " +
        "WHERE id = ?"
    )
      .bind(runId)
      .first();

  if (!run) {
    return redirectPage(
      "/",
      "Publishing run was not found."
    );
  }

  if (
    run.session_id !==
    sessionId
  ) {
    return redirectPage(
      "/",
      "You are not authorized to view this publishing run."
    );
  }

  const rowsResult =
    await env.DB.prepare(
      "SELECT " +
        "facebook_page_id, " +
        "page_name, " +
        "status, " +
        "post_id, " +
        "error, " +
        "completed_at " +
        "FROM publish_run_pages " +
        "WHERE run_id = ? " +
        "ORDER BY id ASC"
    )
      .bind(runId)
      .all();

  const rows =
    rowsResult.results || [];

  const counts =
    await getPublishRunCounts(
      env.DB,
      runId
    );

  let resultRows = "";

  for (const row of rows) {
    const success =
      row.status ===
      "success";

    const statusClass =
      success
        ? "result-success"
        : row.status ===
          "failed"
        ? "result-failed"
        : "result-pending";

    const statusText =
      success
        ? "Published"
        : row.status ===
          "failed"
        ? "Failed"
        : "Pending";

    const statusIcon =
      success
        ? "✓"
        : row.status ===
          "failed"
        ? "!"
        : "…";

    resultRows += `
      <div class="result-row">

        <div class="result-page">

          <div class="result-avatar">
            ${escapeHtml(
              getInitials(
                row.page_name ||
                  "Page"
              )
            )}
          </div>

          <div class="result-page-info">

            <strong>
              ${escapeHtml(
                row.page_name ||
                  "Facebook Page"
              )}
            </strong>

            <span>
              ID:
              ${escapeHtml(
                row.facebook_page_id ||
                  ""
              )}
            </span>

          </div>

        </div>

        <div
          class="result-status ${statusClass}"
        >
          <span>
            ${statusIcon}
          </span>

          ${statusText}
        </div>

        <div class="result-detail">

          ${
            success
              ? `
                ${
                  row.post_id
                    ? `
                      <span class="post-id">
                        Post ID:
                        ${escapeHtml(
                          row.post_id
                        )}
                      </span>
                    `
                    : `
                      <span class="post-id">
                        Published successfully
                      </span>
                    `
                }
              `
              : row.error
              ? `
                <span class="result-error-text">
                  ${escapeHtml(
                    row.error
                  )}
                </span>
              `
              : `
                <span>
                  Waiting...
                </span>
              `
          }

        </div>

      </div>
    `;
  }

  return page(
    "Publishing Results",
    `
    <div class="results-shell">

      <header class="topbar">

        <div class="brand-area">

          <a
            href="/"
            class="brand-icon"
          >
            N
          </a>

          <div class="brand-copy">

            <div class="brand-name">
              ${escapeHtml(
                APP_NAME
              )}
            </div>

            <div class="brand-byline">
              POWERED BY
              <strong>
                NAQI SHAH
              </strong>
            </div>

          </div>

        </div>

        <div class="topbar-actions">

          <div class="live-status">
            <span class="live-dot"></span>
            SYSTEM ONLINE
          </div>

          <a
            href="/logout"
            class="logout-btn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M10 17l5-5-5-5"/>
              <path d="M15 12H3"/>
              <path d="M21 19V5a2 2 0 0 0-2-2h-6"/>
            </svg>

            Logout
          </a>

        </div>

      </header>

      <main class="results-main">

        <section class="results-hero">

          <div class="results-hero-icon">
            ${
              run.status ===
              "completed"
                ? "✓"
                : "…"
            }
          </div>

          <div class="eyebrow">
            PUBLISHING REPORT
          </div>

          <h1>
            ${
              run.status ===
              "completed"
                ? "Publishing completed"
                : "Publishing in progress"
            }
          </h1>

          <p>
            Your publishing run has been processed
            across the selected Facebook Pages.
          </p>

        </section>

        <section class="results-summary">

          <div class="result-stat">

            <div class="result-stat-value">
              ${counts.total}
            </div>

            <div class="result-stat-label">
              TOTAL PAGES
            </div>

          </div>

          <div class="result-stat">

            <div class="result-stat-value">
              ${counts.succeeded}
            </div>

            <div class="result-stat-label">
              SUCCESSFUL
            </div>

          </div>

          <div class="result-stat">

            <div class="result-stat-value">
              ${counts.failed}
            </div>

            <div class="result-stat-label">
              FAILED
            </div>

          </div>

          <div class="result-stat">

            <div class="result-stat-value">
              ${counts.pending}
            </div>

            <div class="result-stat-label">
              PENDING
            </div>

          </div>

        </section>

        <section class="results-card">

          <div class="results-card-header">

            <div>

              <div class="eyebrow">
                PAGE RESULTS
              </div>

              <h2>
                Publishing activity
              </h2>

            </div>

            <a
              href="/"
              class="secondary-btn"
            >
              Back to Dashboard
            </a>

          </div>

          <div class="result-list">

            ${
              resultRows ||
              `
                <div class="no-results">
                  No publishing results available.
                </div>
              `
            }

          </div>

        </section>

        <section class="run-info-card">

          <div class="run-info-item">

            <span>
              Run ID
            </span>

            <strong>
              ${escapeHtml(
                run.id
              )}
            </strong>

          </div>

          <div class="run-info-item">

            <span>
              Created
            </span>

            <strong>
              ${escapeHtml(
                formatDate(
                  run.created_at
                )
              )}
            </strong>

          </div>

          ${
            run.completed_at
              ? `
                <div class="run-info-item">

                  <span>
                    Completed
                  </span>

                  <strong>
                    ${escapeHtml(
                      formatDate(
                        run.completed_at
                      )
                    )}
                  </strong>

                </div>
              `
              : ""
          }

          <div class="run-info-item">

            <span>
              Media
            </span>

            <strong>
              ${
                run.media_name
                  ? escapeHtml(
                      run.media_name
                    )
                  : "Text only"
              }
            </strong>

          </div>

        </section>

      </main>

      <footer class="dashboard-footer">

        <div>
          ${escapeHtml(
            APP_NAME
          )}
        </div>

        <div>
          Crafted for
          <strong>
            NAQI SHAH
          </strong>
        </div>

      </footer>

    </div>
    `
  );
}

// =============================================================
// FACEBOOK PUBLISHING
// =============================================================

async function publishToPage(
  env,
  page,
  message,
  media
) {
  const config =
    getMetaConfig(env);

  const pageId =
    String(
      page.facebook_page_id
    );

  const accessToken =
    String(
      page.access_token
    );

  if (!pageId) {
    throw new Error(
      "Facebook Page ID is missing."
    );
  }

  if (!accessToken) {
    throw new Error(
      "Facebook Page access token is missing."
    );
  }

  if (
    isValidMediaFile(media)
  ) {
    const mediaType =
      String(
        media.type || ""
      ).toLowerCase();

    if (
      mediaType.startsWith(
        "video/"
      )
    ) {
      return publishVideoToPage(
        env,
        pageId,
        accessToken,
        message,
        media
      );
    }

    return publishPhotoToPage(
      env,
      pageId,
      accessToken,
      message,
      media
    );
  }

  return publishTextToPage(
    env,
    pageId,
    accessToken,
    message
  );
}

async function publishTextToPage(
  env,
  pageId,
  accessToken,
  message
) {
  const config =
    getMetaConfig(env);

  const endpoint =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/" +
    encodeURIComponent(
      pageId
    ) +
    "/feed";

  const body =
    new URLSearchParams();

  body.set(
    "message",
    message || ""
  );

  body.set(
    "access_token",
    accessToken
  );

  const response =
    await fetch(
      endpoint,
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
    await parseGraphResponse(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      getGraphErrorMessage(
        data,
        "Facebook text post failed."
      )
    );
  }

  return {
    postId:
      data.id ||
      data.post_id ||
      null,
    raw: data
  };
}

async function publishPhotoToPage(
  env,
  pageId,
  accessToken,
  message,
  media
) {
  const config =
    getMetaConfig(env);

  const endpoint =
    "https://graph.facebook.com/" +
    config.graphVersion +
    "/" +
    encodeURIComponent(
      pageId
    ) +
    "/photos";

  const form =
    new FormData();

  form.append(
    "access_token",
    accessToken
  );

  if (message) {
    form.append(
      "caption",
      message
    );
  }

  form.append(
    "source",
    media,
    media.name ||
      "upload.jpg"
  );

  const response =
    await fetch(
      endpoint,
      {
        method: "POST",
        body: form
      }
    );

  const data =
    await parseGraphResponse(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      getGraphErrorMessage(
        data,
        "Facebook photo post failed."
      )
    );
  }

  return {
    postId:
      data.post_id ||
      data.id ||
      null,
    raw: data
  };
}

async function publishVideoToPage(
  env,
  pageId,
  accessToken,
  message,
  media
) {
  const config =
    getMetaConfig(env);

  const endpoint =
    "https://graph-video.facebook.com/" +
    config.graphVersion +
    "/" +
    encodeURIComponent(
      pageId
    ) +
    "/videos";

  const form =
    new FormData();

  form.append(
    "access_token",
    accessToken
  );

  if (message) {
    form.append(
      "description",
      message
    );
  }

  form.append(
    "source",
    media,
    media.name ||
      "upload.mp4"
  );

  const response =
    await fetch(
      endpoint,
      {
        method: "POST",
        body: form
      }
    );

  const data =
    await parseGraphResponse(
      response
    );

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      getGraphErrorMessage(
        data,
        "Facebook video post failed."
      )
    );
  }

  return {
    postId:
      data.post_id ||
      data.id ||
      null,
    raw: data
  };
}

// =============================================================
// GRAPH API RESPONSE HELPERS
// =============================================================

async function parseGraphResponse(
  response
) {
  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(
      text
    );
  } catch (error) {
    return {
      error: {
        message:
          "Facebook returned a non-JSON response (HTTP " +
          response.status +
          "). " +
          text.slice(0, 500)
      }
    };
  }
}

function getGraphErrorMessage(
  data,
  fallback
) {
  if (
    data &&
    data.error
  ) {
    const error =
      data.error;

    const parts = [];

    if (error.message) {
      parts.push(
        String(
          error.message
        )
      );
    }

    if (
      error.error_user_msg
    ) {
      parts.push(
        String(
          error.error_user_msg
        )
      );
    }

    if (
      error.error_subcode
    ) {
      parts.push(
        "Subcode: " +
          String(
            error.error_subcode
          )
      );
    }

    if (
      error.code
    ) {
      parts.push(
        "Code: " +
          String(
            error.code
          )
      );
    }

    if (parts.length) {
      return parts.join(
        " | "
      );
    }
  }

  return fallback;
}

// =============================================================
// MEDIA HELPERS
// =============================================================

function isValidMediaFile(
  value
) {
  if (!value) {
    return false;
  }

  if (
    typeof value !==
    "object"
  ) {
    return false;
  }

  if (
    typeof value.size !==
    "number"
  ) {
    return false;
  }

  if (
    value.size <= 0
  ) {
    return false;
  }

  return (
    typeof value.type ===
      "string" ||
    typeof value.name ===
      "string"
  );
}

async function getMediaFromFormRequest(
  request
) {
  // ---------------------------------------------------------
  // This helper is intentionally lightweight.
  // The multipart body has already been consumed by
  // startPublishRun() when the publishing run was created.
  // If a batch request contains media again, read it here.
  // ---------------------------------------------------------

  try {
    const form =
      await request.formData();

    const media =
      form.get("media");

    return isValidMediaFile(
      media
    )
      ? media
      : null;
  } catch (error) {
    return null;
  }
}

// =============================================================
// GENERAL RESPONSE HELPERS
// =============================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store"
      }
    }
  );
}

function redirectPage(
  location,
  message
) {
  const url =
    new URL(
      location,
      "https://example.com"
    );

  if (message) {
    url.searchParams.set(
      "message",
      message
    );
  }

  return new Response(
    null,
    {
      status: 302,
      headers: {
        Location:
          url.pathname +
          url.search,
        "Cache-Control":
          "no-store"
      }
    }
  );
}

function page(
  title,
  content
) {
  return new Response(
    `
<!DOCTYPE html>
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

  <title>
    ${escapeHtml(
      title
    )} · ${escapeHtml(
      APP_NAME
    )}
  </title>

  <style>
    :root {
      --bg: #07090d;
      --bg-soft: #0c1017;
      --card: rgba(18, 23, 32, 0.82);
      --card-strong: #111722;
      --line: rgba(255, 255, 255, 0.09);
      --line-strong: rgba(255, 255, 255, 0.14);
      --text: #f4f7fb;
      --muted: #9ca7b8;
      --muted-2: #687386;
      --accent: #1877f2;
      --accent-2: #4f9cff;
      --success: #35d49a;
      --danger: #ff647c;
      --warning: #ffc857;
      --shadow:
        0 24px 80px rgba(0, 0, 0, 0.42);
      --radius: 22px;
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background: var(--bg);
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(
          circle at 15% 5%,
          rgba(24, 119, 242, 0.11),
          transparent 32%
        ),
        radial-gradient(
          circle at 90% 20%,
          rgba(95, 74, 255, 0.08),
          transparent 30%
        ),
        linear-gradient(
          180deg,
          #080a0f 0%,
          #07090d 100%
        );
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.32;
      background-image:
        linear-gradient(
          rgba(255,255,255,0.025) 1px,
          transparent 1px
        ),
        linear-gradient(
          90deg,
          rgba(255,255,255,0.025) 1px,
          transparent 1px
        );
      background-size:
        40px 40px;
      mask-image:
        linear-gradient(
          to bottom,
          black,
          transparent 75%
        );
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

    .dashboard-shell,
    .results-shell {
      position: relative;
      min-height: 100vh;
      z-index: 1;
    }

    .topbar {
      width: min(
        1440px,
        calc(100% - 48px)
      );
      margin: 0 auto;
      min-height: 82px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      border-bottom: 1px solid var(--line);
    }

    .brand-area {
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .brand-icon {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      display: grid;
      place-items: center;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #5a9fff
        );
      color: white;
      font-size: 20px;
      font-weight: 900;
      box-shadow:
        0 10px 28px
        rgba(24,119,242,.25);
    }

    .brand-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .brand-name {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: .02em;
    }

    .brand-byline {
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 700;
      letter-spacing: .17em;
    }

    .brand-byline strong {
      color: var(--muted);
      font-weight: 800;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .live-status {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted-2);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: .13em;
    }

    .live-dot,
    .status-dot,
    .ready-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow:
        0 0 0 4px
        rgba(53,212,154,.08),
        0 0 14px
        rgba(53,212,154,.5);
    }

    .logout-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 9px 13px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--muted);
      background: rgba(255,255,255,.025);
      font-size: 11px;
      font-weight: 700;
      transition:
        .2s ease;
    }

    .logout-btn:hover {
      border-color:
        var(--line-strong);
      color: var(--text);
      background:
        rgba(255,255,255,.05);
    }

    .logout-btn svg {
      width: 15px;
      height: 15px;
    }

    .dashboard-main,
    .results-main {
      width: min(
        1440px,
        calc(100% - 48px)
      );
      margin: 0 auto;
      padding:
        66px 0 70px;
    }

    .hero-section {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 60px;
      padding-bottom: 54px;
    }

    .hero-copy {
      max-width: 760px;
    }

    .eyebrow {
      color: var(--accent-2);
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .2em;
      text-transform: uppercase;
    }

    .hero-copy h1 {
      margin:
        14px 0 17px;
      font-size:
        clamp(40px, 5vw, 68px);
      line-height: .98;
      letter-spacing:
        -.055em;
      font-weight: 900;
    }

    .hero-copy h1 span {
      display: block;
      color: transparent;
      background:
        linear-gradient(
          100deg,
          #4d9cff,
          #91bfff
        );
      background-clip: text;
      -webkit-background-clip: text;
    }

    .hero-copy p {
      max-width: 630px;
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.8;
    }

    .hero-stats {
      display: flex;
      gap: 12px;
      flex-shrink: 0;
    }

    .stat-card {
      width: 132px;
      min-height: 132px;
      padding: 19px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background:
        linear-gradient(
          145deg,
          rgba(255,255,255,.055),
          rgba(255,255,255,.018)
        );
      box-shadow:
        0 14px 45px
        rgba(0,0,0,.17);
    }

    .stat-icon {
      width: 31px;
      height: 31px;
      display: grid;
      place-items: center;
      margin-bottom: 17px;
      border-radius: 9px;
      background:
        rgba(24,119,242,.1);
      color: var(--accent-2);
    }

    .stat-icon svg {
      width: 16px;
      height: 16px;
    }

    .stat-value {
      font-size: 27px;
      font-weight: 900;
      letter-spacing: -.04em;
    }

    .stat-label {
      margin-top: 2px;
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .16em;
    }

    .section-heading,
    .publisher-heading,
    .results-card-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 25px;
    }

    .section-heading {
      margin-bottom: 20px;
    }

    .section-heading h2,
    .publisher-heading h2,
    .results-card-header h2 {
      margin:
        7px 0 0;
      font-size: 24px;
      letter-spacing: -.035em;
    }

    .primary-btn,
    .secondary-btn,
    .danger-btn,
    .publish-btn,
    .login-submit,
    .back-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      border-radius: 11px;
      transition:
        transform .18s ease,
        border-color .18s ease,
        background .18s ease,
        box-shadow .18s ease;
    }

    .primary-btn {
      padding: 11px 15px;
      border:
        1px solid
        rgba(79,156,255,.28);
      color: white;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #246fe0
        );
      box-shadow:
        0 12px 30px
        rgba(24,119,242,.2);
      font-size: 11px;
      font-weight: 800;
    }

    .primary-btn:hover {
      transform:
        translateY(-1px);
      box-shadow:
        0 15px 34px
        rgba(24,119,242,.28);
    }

    .primary-btn.small {
      padding:
        10px 14px;
    }

    .fb-symbol {
      width: 17px;
      height: 17px;
      display: grid;
      place-items: center;
      border-radius: 5px;
      background: white;
      color: #1877f2;
      font-size: 13px;
      font-weight: 900;
      line-height: 1;
    }

    .accounts-container {
      display: grid;
      gap: 17px;
    }

    .account-card {
      overflow: hidden;
      border:
        1px solid var(--line);
      border-radius:
        var(--radius);
      background:
        linear-gradient(
          145deg,
          rgba(18,23,32,.9),
          rgba(11,15,22,.88)
        );
      box-shadow:
        var(--shadow);
    }

    .account-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 25px;
      padding: 22px 24px;
      border-bottom:
        1px solid var(--line);
    }

    .account-identity {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .account-avatar,
    .result-avatar {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 14px;
      background:
        linear-gradient(
          135deg,
          #1b7ff4,
          #3f5efb
        );
      color: white;
      font-size: 15px;
      font-weight: 900;
      box-shadow:
        0 9px 22px
        rgba(24,119,242,.2);
    }

    .account-avatar {
      width: 48px;
      height: 48px;
    }

    .account-details {
      min-width: 0;
    }

    .account-label {
      margin-bottom: 3px;
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .16em;
    }

    .account-details h3 {
      overflow: hidden;
      margin: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
    }

    .account-id {
      margin-top: 3px;
      overflow: hidden;
      color: var(--muted-2);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .account-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .account-actions form {
      margin: 0;
    }

    .secondary-btn,
    .danger-btn {
      padding:
        9px 12px;
      border:
        1px solid var(--line);
      background:
        rgba(255,255,255,.025);
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
    }

    .secondary-btn:hover {
      border-color:
        rgba(79,156,255,.3);
      color: var(--text);
      background:
        rgba(24,119,242,.07);
    }

    .secondary-btn svg,
    .danger-btn svg {
      width: 14px;
      height: 14px;
    }

    .danger-btn {
      color:
        rgba(255,100,124,.78);
    }

    .danger-btn:hover {
      border-color:
        rgba(255,100,124,.25);
      color: var(--danger);
      background:
        rgba(255,100,124,.06);
    }

    .page-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding:
        18px 24px 12px;
    }

    .toolbar-title {
      font-size: 11px;
      font-weight: 800;
    }

    .toolbar-subtitle {
      margin-top: 3px;
      color: var(--muted-2);
      font-size: 9px;
    }

    .toolbar-actions {
      display: flex;
      gap: 6px;
    }

    .toolbar-btn {
      padding:
        7px 9px;
      border:
        1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background:
        rgba(255,255,255,.025);
      font-size: 9px;
      font-weight: 800;
    }

    .toolbar-btn:hover {
      color: var(--text);
      border-color:
        var(--line-strong);
    }

    .page-list {
      display: grid;
      gap: 1px;
      padding:
        0 12px 12px;
    }

    .page-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 65px;
      padding:
        8px 12px;
      border-radius: 13px;
      cursor: pointer;
      transition:
        background .16s ease;
    }

    .page-row:hover {
      background:
        rgba(255,255,255,.035);
    }

    .page-row input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .custom-check {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border:
        1px solid
        rgba(255,255,255,.16);
      border-radius: 6px;
      background:
        rgba(255,255,255,.02);
      transition:
        .16s ease;
    }

    .custom-check svg {
      width: 12px;
      height: 12px;
      opacity: 0;
      color: white;
      transition:
        .16s ease;
    }

    .page-row input:checked
      + .custom-check {
      border-color:
        #1877f2;
      background:
        #1877f2;
      box-shadow:
        0 0 0 4px
        rgba(24,119,242,.09);
    }

    .page-row input:checked
      + .custom-check svg {
      opacity: 1;
    }

    .page-avatar {
      width: 37px;
      height: 37px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 11px;
      background:
        rgba(255,255,255,.07);
      color: #dce7f8;
      font-size: 11px;
      font-weight: 900;
    }

    .page-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }

    .page-name {
      overflow: hidden;
      font-size: 12px;
      font-weight: 800;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-id {
      margin-top: 2px;
      overflow: hidden;
      color: var(--muted-2);
      font-size: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-ready {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted-2);
      font-size: 9px;
      font-weight: 700;
    }

    .page-ready .ready-dot {
      width: 5px;
      height: 5px;
      box-shadow: none;
    }

    .no-pages {
      display: flex;
      align-items: center;
      gap: 13px;
      margin:
        0 24px 22px;
      padding: 17px;
      border:
        1px dashed
        rgba(255,255,255,.12);
      border-radius: 13px;
      color: var(--muted);
    }

    .no-pages-icon {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 9px;
      background:
        rgba(255,200,87,.08);
      color: var(--warning);
      font-weight: 900;
    }

    .no-pages strong {
      color: var(--text);
      font-size: 11px;
    }

    .no-pages p {
      margin:
        3px 0 0;
      font-size: 9px;
    }

    .empty-state {
      display: grid;
      place-items: center;
      text-align: center;
      padding:
        75px 25px;
      border:
        1px dashed
        rgba(255,255,255,.11);
      border-radius:
        var(--radius);
      background:
        rgba(255,255,255,.018);
    }

    .empty-icon {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      margin-bottom: 17px;
      border-radius: 16px;
      background:
        rgba(24,119,242,.08);
      color: var(--accent-2);
    }

    .empty-icon svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .empty-state h3 {
      margin:
        9px 0 7px;
      font-size: 18px;
    }

    .empty-state p {
      max-width: 500px;
      margin:
        0 auto 20px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.7;
    }

    .publisher-section {
      margin-top: 35px;
      padding: 27px;
      border:
        1px solid var(--line);
      border-radius:
        var(--radius);
      background:
        linear-gradient(
          145deg,
          rgba(18,23,32,.92),
          rgba(10,14,21,.9)
        );
      box-shadow:
        var(--shadow);
    }

    .publisher-heading {
      align-items: flex-start;
      margin-bottom: 25px;
    }

    .publisher-heading p {
      margin:
        7px 0 0;
      color: var(--muted);
      font-size: 11px;
    }

    .publisher-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding:
        8px 10px;
      border:
        1px solid
        rgba(53,212,154,.13);
      border-radius: 9px;
      background:
        rgba(53,212,154,.045);
      color:
        rgba(157,239,211,.72);
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .11em;
    }

    .publisher-badge .ready-dot {
      width: 5px;
      height: 5px;
      box-shadow: none;
    }

    .form-grid {
      display: grid;
      grid-template-columns:
        minmax(0, 1.45fr)
        minmax(270px, .75fr);
      gap: 18px;
    }

    .field-label {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 8px;
      color: #dfe6f1;
      font-size: 10px;
      font-weight: 800;
    }

    .optional {
      color: var(--muted-2);
      font-size: 7px;
      letter-spacing: .1em;
    }

    textarea,
    input[type="password"] {
      width: 100%;
      border:
        1px solid var(--line);
      outline: none;
      border-radius: 13px;
      color: var(--text);
      background:
        rgba(5,8,12,.58);
      transition:
        border-color .18s ease,
        box-shadow .18s ease;
    }

    textarea {
      min-height: 190px;
      resize: vertical;
      padding: 15px;
      line-height: 1.65;
      font-size: 12px;
    }

    textarea::placeholder,
    input::placeholder {
      color:
        rgba(156,167,184,.38);
    }

    textarea:focus,
    input[type="password"]:focus {
      border-color:
        rgba(79,156,255,.48);
      box-shadow:
        0 0 0 4px
        rgba(24,119,242,.07);
    }

    .field-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 7px;
      color: var(--muted-2);
      font-size: 8px;
    }

    .upload-zone {
      min-height: 190px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      border:
        1px dashed
        rgba(255,255,255,.13);
      border-radius: 13px;
      background:
        rgba(5,8,12,.45);
      cursor: pointer;
      text-align: center;
      transition:
        .18s ease;
    }

    .upload-zone:hover {
      border-color:
        rgba(79,156,255,.4);
      background:
        rgba(24,119,242,.035);
    }

    .upload-zone input {
      display: none;
    }

    .upload-icon {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      margin-bottom: 11px;
      border-radius: 13px;
      background:
        rgba(24,119,242,.09);
      color: var(--accent-2);
    }

    .upload-icon svg {
      width: 21px;
      height: 21px;
    }

    .upload-zone strong {
      font-size: 11px;
    }

    .upload-zone span {
      margin-top: 4px;
      color: var(--muted);
      font-size: 9px;
    }

    .upload-zone small {
      margin-top: 10px;
      color: var(--muted-2);
      font-size: 8px;
    }

    .file-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 8px;
      padding:
        9px 11px;
      border:
        1px solid
        rgba(53,212,154,.12);
      border-radius: 9px;
      background:
        rgba(53,212,154,.035);
      color: var(--muted);
      font-size: 9px;
    }

    .file-info strong {
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hidden {
      display: none !important;
    }

    .publish-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-top: 18px;
      padding-top: 18px;
      border-top:
        1px solid var(--line);
    }

    .selection-summary {
      display: flex;
      align-items: center;
      gap: 9px;
      color: var(--muted);
      font-size: 10px;
    }

    .selection-icon {
      width: 25px;
      height: 25px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background:
        rgba(53,212,154,.08);
      color: var(--success);
      font-size: 11px;
      font-weight: 900;
    }

    .selection-summary strong {
      color: var(--text);
    }

    .publish-btn {
      min-width: 145px;
      padding:
        12px 16px;
      border:
        1px solid
        rgba(79,156,255,.3);
      color: white;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #286fd7
        );
      box-shadow:
        0 13px 30px
        rgba(24,119,242,.2);
      font-size: 11px;
      font-weight: 900;
    }

    .publish-btn:hover:not(:disabled) {
      transform:
        translateY(-1px);
      box-shadow:
        0 16px 35px
        rgba(24,119,242,.27);
    }

    .publish-btn:disabled {
      opacity: .55;
      cursor:
        not-allowed;
    }

    .publish-btn svg {
      width: 16px;
      height: 16px;
    }

    .publish-status {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
      padding:
        13px 15px;
      border:
        1px solid
        rgba(79,156,255,.12);
      border-radius: 12px;
      background:
        rgba(24,119,242,.045);
      color: var(--muted);
      font-size: 10px;
    }

    .publish-status strong {
      display: block;
      margin-bottom: 2px;
      color: var(--text);
      font-size: 10px;
    }

    .publish-status span {
      color: var(--muted);
    }

    .publish-status.error {
      border-color:
        rgba(255,100,124,.16);
      background:
        rgba(255,100,124,.045);
    }

    .publish-status.success {
      border-color:
        rgba(53,212,154,.16);
      background:
        rgba(53,212,154,.045);
    }

    .status-spinner {
      width: 19px;
      height: 19px;
      flex-shrink: 0;
      border:
        2px solid
        rgba(255,255,255,.12);
      border-top-color:
        var(--accent-2);
      border-radius: 50%;
      animation:
        spin .8s linear infinite;
    }

    .status-success-icon,
    .status-message-icon {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 900;
    }

    .status-success-icon {
      background:
        rgba(53,212,154,.1);
      color: var(--success);
    }

    .status-message-icon {
      background:
        rgba(255,100,124,.1);
      color: var(--danger);
    }

    @keyframes spin {
      to {
        transform:
          rotate(360deg);
      }
    }

    .dashboard-footer {
      width: min(
        1440px,
        calc(100% - 48px)
      );
      margin: 0 auto;
      padding:
        22px 0 27px;
      border-top:
        1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 700;
      letter-spacing: .05em;
    }

    .dashboard-footer strong {
      color: var(--muted);
    }

    /* ---------------------------------------------------------
       LOGIN
       --------------------------------------------------------- */

    .login-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      position: relative;
      overflow: hidden;
      padding: 30px;
    }

    .login-glow {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(100px);
      pointer-events: none;
      opacity: .13;
    }

    .login-glow-one {
      top: -250px;
      left: -180px;
      background:
        #1877f2;
    }

    .login-glow-two {
      right: -220px;
      bottom: -280px;
      background:
        #6c4cff;
    }

    .login-card {
      position: relative;
      width: min(
        430px,
        100%
      );
      padding:
        42px;
      border:
        1px solid var(--line);
      border-radius:
        26px;
      background:
        linear-gradient(
          145deg,
          rgba(19,24,34,.93),
          rgba(10,14,21,.96)
        );
      box-shadow:
        0 30px 100px
        rgba(0,0,0,.48);
      backdrop-filter:
        blur(20px);
      text-align: center;
    }

    .brand-mark {
      width: 62px;
      height: 62px;
      display: grid;
      place-items: center;
      margin:
        0 auto 20px;
      border-radius: 19px;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #5b9fff
        );
      box-shadow:
        0 18px 42px
        rgba(24,119,242,.24);
    }

    .brand-mark-inner {
      font-size: 28px;
      font-weight: 950;
    }

    .login-card h1 {
      margin:
        9px 0 9px;
      font-size: 24px;
      letter-spacing: -.045em;
    }

    .login-subtitle {
      margin:
        0 auto 24px;
      max-width: 310px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.65;
    }

    .login-error {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      margin-bottom: 16px;
      padding:
        11px 12px;
      border:
        1px solid
        rgba(255,100,124,.16);
      border-radius: 10px;
      background:
        rgba(255,100,124,.045);
      color:
        rgba(255,190,199,.88);
      font-size: 10px;
      line-height: 1.45;
      text-align: left;
    }

    .login-error-icon {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border-radius: 6px;
      background:
        rgba(255,100,124,.12);
      color: var(--danger);
      font-size: 10px;
      font-weight: 900;
    }

    .login-form {
      text-align: left;
    }

    .password-wrap {
      position: relative;
    }

    input[type="password"] {
      height: 48px;
      padding:
        0 46px 0 14px;
      font-size: 12px;
    }

    .password-toggle {
      position: absolute;
      top: 50%;
      right: 12px;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      transform:
        translateY(-50%);
      border: 0;
      border-radius: 7px;
      color: var(--muted-2);
      background: transparent;
    }

    .password-toggle:hover {
      color: var(--text);
      background:
        rgba(255,255,255,.05);
    }

    .password-toggle svg {
      width: 16px;
      height: 16px;
    }

    .login-submit {
      width: 100%;
      height: 48px;
      margin-top: 12px;
      border:
        1px solid
        rgba(79,156,255,.28);
      color: white;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #286fd7
        );
      box-shadow:
        0 13px 32px
        rgba(24,119,242,.2);
      font-size: 11px;
      font-weight: 900;
    }

    .login-submit:hover {
      transform:
        translateY(-1px);
      box-shadow:
        0 17px 38px
        rgba(24,119,242,.28);
    }

    .login-submit svg {
      width: 16px;
      height: 16px;
    }

    .login-footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      margin-top: 22px;
      color: var(--muted-2);
      font-size: 8px;
    }

    .naqi-signature {
      margin-top: 25px;
      color:
        rgba(255,255,255,.17);
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .27em;
    }

    /* ---------------------------------------------------------
       ERROR / SUCCESS SCREENS
       --------------------------------------------------------- */

    .error-screen,
    .success-screen {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 30px;
    }

    .error-box,
    .success-box {
      width: min(
        560px,
        100%
      );
      padding: 38px;
      border:
        1px solid var(--line);
      border-radius: 23px;
      background:
        rgba(15,20,28,.92);
      box-shadow:
        var(--shadow);
      text-align: center;
    }

    .error-icon,
    .success-icon {
      width: 58px;
      height: 58px;
      display: grid;
      place-items: center;
      margin:
        0 auto 18px;
      border-radius: 18px;
      font-size: 24px;
      font-weight: 950;
    }

    .error-icon {
      background:
        rgba(255,100,124,.08);
      color: var(--danger);
    }

    .success-icon {
      background:
        rgba(53,212,154,.08);
      color: var(--success);
    }

    .error-box h2,
    .success-box h2 {
      margin:
        9px 0 9px;
      font-size: 25px;
      letter-spacing: -.04em;
    }

    .error-intro,
    .success-intro {
      margin:
        0 auto 22px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.7;
    }

    .error-box pre {
      max-width: 100%;
      margin:
        0 0 22px;
      padding: 13px;
      overflow: auto;
      border:
        1px solid var(--line);
      border-radius: 10px;
      background:
        rgba(0,0,0,.25);
      color:
        rgba(255,180,190,.8);
      font-size: 9px;
      line-height: 1.55;
      text-align: left;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .back-btn {
      padding:
        11px 15px;
      border:
        1px solid var(--line);
      background:
        rgba(255,255,255,.04);
      color: var(--text);
      font-size: 10px;
      font-weight: 800;
    }

    .back-btn:hover {
      border-color:
        var(--line-strong);
      background:
        rgba(255,255,255,.07);
    }

    .success-back {
      border-color:
        rgba(53,212,154,.17);
      background:
        rgba(53,212,154,.07);
    }

    .success-stats {
      display: flex;
      justify-content: center;
      margin:
        0 0 22px;
    }

    .success-stats > div {
      min-width: 130px;
      padding:
        15px 22px;
      border:
        1px solid var(--line);
      border-radius: 13px;
      background:
        rgba(255,255,255,.025);
    }

    .success-stats strong {
      display: block;
      font-size: 25px;
    }

    .success-stats span {
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 800;
      letter-spacing: .12em;
    }

    /* ---------------------------------------------------------
       RESULTS
       --------------------------------------------------------- */

    .results-hero {
      max-width: 760px;
      margin:
        0 auto 35px;
      text-align: center;
    }

    .results-hero-icon {
      width: 58px;
      height: 58px;
      display: grid;
      place-items: center;
      margin:
        0 auto 17px;
      border-radius: 18px;
      background:
        rgba(53,212,154,.08);
      color: var(--success);
      font-size: 25px;
      font-weight: 950;
    }

    .results-hero h1 {
      margin:
        9px 0 8px;
      font-size:
        clamp(31px, 4vw, 46px);
      letter-spacing:
        -.05em;
    }

    .results-hero p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.7;
    }

    .results-summary {
      display: grid;
      grid-template-columns:
        repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }

    .result-stat {
      padding: 19px;
      border:
        1px solid var(--line);
      border-radius: 16px;
      background:
        rgba(255,255,255,.025);
    }

    .result-stat-value {
      font-size: 27px;
      font-weight: 900;
      letter-spacing: -.04em;
    }

    .result-stat-label {
      margin-top: 3px;
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .14em;
    }

    .results-card {
      overflow: hidden;
      border:
        1px solid var(--line);
      border-radius:
        var(--radius);
      background:
        rgba(15,20,28,.9);
      box-shadow:
        var(--shadow);
    }

    .results-card-header {
      padding:
        22px 24px;
      border-bottom:
        1px solid var(--line);
    }

    .result-list {
      display: grid;
    }

    .result-row {
      display: grid;
      grid-template-columns:
        minmax(240px, 1.4fr)
        120px
        minmax(230px, 1fr);
      align-items: center;
      gap: 20px;
      min-height: 72px;
      padding:
        10px 24px;
      border-bottom:
        1px solid var(--line);
    }

    .result-row:last-child {
      border-bottom: 0;
    }

    .result-page {
      display: flex;
      align-items: center;
      gap: 11px;
      min-width: 0;
    }

    .result-avatar {
      width: 39px;
      height: 39px;
      border-radius: 11px;
      font-size: 10px;
    }

    .result-page-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .result-page-info strong {
      overflow: hidden;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .result-page-info span {
      margin-top: 2px;
      overflow: hidden;
      color: var(--muted-2);
      font-size: 8px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .result-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: fit-content;
      padding:
        6px 8px;
      border-radius: 8px;
      font-size: 8px;
      font-weight: 900;
    }

    .result-success {
      color:
        rgba(131,238,196,.88);
      background:
        rgba(53,212,154,.07);
    }

    .result-failed {
      color:
        rgba(255,150,164,.9);
      background:
        rgba(255,100,124,.07);
    }

    .result-pending {
      color:
        rgba(255,214,128,.9);
      background:
        rgba(255,200,87,.07);
    }

    .result-detail {
      min-width: 0;
      color: var(--muted-2);
      font-size: 9px;
    }

    .post-id {
      overflow: hidden;
      display: block;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .result-error-text {
      display: block;
      overflow: hidden;
      color:
        rgba(255,160,174,.76);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .no-results {
      padding: 35px;
      color: var(--muted);
      text-align: center;
      font-size: 11px;
    }

    .run-info-card {
      display: grid;
      grid-template-columns:
        repeat(4, 1fr);
      gap: 1px;
      margin-top: 14px;
      overflow: hidden;
      border:
        1px solid var(--line);
      border-radius: 16px;
      background:
        var(--line);
    }

    .run-info-item {
      min-width: 0;
      padding: 15px;
      background:
        rgba(15,20,28,.86);
    }

    .run-info-item span {
      display: block;
      margin-bottom: 4px;
      color: var(--muted-2);
      font-size: 8px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .run-info-item strong {
      display: block;
      overflow: hidden;
      color: var(--muted);
      font-size: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ---------------------------------------------------------
       RESPONSIVE
       --------------------------------------------------------- */

    @media (max-width: 900px) {
      .hero-section {
        align-items: flex-start;
        flex-direction: column;
        gap: 28px;
      }

      .hero-stats {
        width: 100%;
      }

      .stat-card {
        flex: 1;
        width: auto;
      }

      .form-grid {
        grid-template-columns:
          1fr;
      }

      .results-summary {
        grid-template-columns:
          repeat(2, 1fr);
      }

      .run-info-card {
        grid-template-columns:
          repeat(2, 1fr);
      }

      .result-row {
        grid-template-columns:
          1fr 110px;
      }

      .result-detail {
        grid-column:
          1 / -1;
        padding:
          0 0 8px 50px;
      }
    }

    @media (max-width: 680px) {
      .topbar,
      .dashboard-main,
      .results-main,
      .dashboard-footer {
        width:
          calc(100% - 28px);
      }

      .topbar {
        min-height: 70px;
      }

      .live-status {
        display: none;
      }

      .brand-name {
        font-size: 12px;
      }

      .dashboard-main,
      .results-main {
        padding-top: 42px;
      }

      .hero-copy h1 {
        font-size: 40px;
      }

      .section-heading,
      .publisher-heading,
      .results-card-header {
        align-items: flex-start;
        flex-direction: column;
      }

      .account-top {
        align-items: flex-start;
        flex-direction: column;
      }

      .account-actions {
        width: 100%;
      }

      .account-actions form {
        flex: 1;
      }

      .account-actions button {
        width: 100%;
      }

      .page-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .publisher-section {
        padding: 18px;
      }

      .publish-footer {
        align-items: stretch;
        flex-direction: column;
      }

      .publish-btn {
        width: 100%;
      }

      .login-card {
        padding: 30px 22px;
      }

      .results-card-header {
        padding: 18px;
      }

      .result-row {
        grid-template-columns:
          1fr;
        gap: 9px;
        padding:
          14px 18px;
      }

      .result-status {
        margin-left: 50px;
      }

      .result-detail {
        padding:
          0 0 0 50px;
      }

      .run-info-card {
        grid-template-columns:
          1fr;
      }

      .dashboard-footer {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>

</head>

<body>

  ${content}

</body>

</html>
    `,
    {
      "Content-Type":
        "text/html; charset=utf-8",
      "Cache-Control":
        "no-store"
    }
  );
}

function getInitials(
  value
) {
  const text =
    String(
      value || ""
    ).trim();

  if (!text) {
    return "NA";
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

function formatDate(
  value
) {
  if (!value) {
    return "—";
  }

  const date =
    new Date(
      String(value)
        .replace(
          " ",
          "T"
        ) +
        (
          String(value).includes(
            "Z"
          )
            ? ""
            : "Z"
        )
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(
      value
    );
  }

  return date.toLocaleString(
    "en-US",
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }
  );
}

function escapeHtml(
  value
) {
  return String(
    value == null
      ? ""
      : value
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}
