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
      //
      // IMPORTANT:
      // Every successful dashboard GET consumes the one-time
      // dashboard ticket.
      //
      // Therefore:
      // Login -> Dashboard works
      // Refresh Dashboard -> Login required
      // Open Dashboard URL again -> Login required
      // ---------------------------------------------------------
      if (request.method === "GET" && path === "/") {
        const allowed = await consumeDashboardTicket(env.DB, auth.sessionId);

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

      if (request.method === "GET" && path === "/auth/meta/callback") {
        return metaCallback(request, env, auth.sessionId);
      }

      // ---------------------------------------------------------
      // SYNC
      // ---------------------------------------------------------
      if (request.method === "POST" && path === "/sync") {
        const response = await syncPages(request, env);

        await allowNextDashboardLoad(env.DB, auth.sessionId);

        return response;
      }

      // ---------------------------------------------------------
      // REMOVE ACCOUNT
      // ---------------------------------------------------------
      if (request.method === "POST" && path === "/remove-account") {
        const response = await removeAccount(request, env);

        await allowNextDashboardLoad(env.DB, auth.sessionId);

        return response;
      }

      // ---------------------------------------------------------
      // PUBLISH
      // ---------------------------------------------------------
      if (request.method === "POST" && path === "/publish") {
        return publishPost(request, env, auth.sessionId);
      }

      // ---------------------------------------------------------
      // LOGOUT
      // ---------------------------------------------------------
      if (
        (request.method === "POST" || request.method === "GET") &&
        path === "/logout"
      ) {
        await deleteSession(env.DB, auth.sessionId);
        return handleLogout();
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

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
              error && (error.stack || error.message)
                ? error.stack || error.message
                : String(error)
            )}</pre>
            <a class="back-btn" href="/login">Return to Login</a>
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
  const password = String(env.PUBLISHER_PASSWORD || "").trim();

  if (!password) {
    throw new Error(
      "PUBLISHER_PASSWORD secret is missing. Add it in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionId = cookies.mp_session;

  if (!sessionId) {
    return null;
  }

  const session = await env.DB.prepare(
    "SELECT id, created_at, dashboard_ticket FROM auth_sessions WHERE id = ?"
  )
    .bind(sessionId)
    .first();

  if (!session) {
    return null;
  }

  // Session lifetime: 24 hours.
  const created = Date.parse(String(session.created_at || ""));
  if (Number.isFinite(created) && Date.now() - created > 24 * 60 * 60 * 1000) {
    await deleteSession(env.DB, sessionId);
    return null;
  }

  return {
    sessionId,
    dashboardTicket: Number(session.dashboard_ticket || 0)
  };
}

async function handleLogin(request, env) {
  const configuredPassword = String(env.PUBLISHER_PASSWORD || "").trim();

  if (!configuredPassword) {
    return showLoginPage(
      "PUBLISHER_PASSWORD secret is not configured."
    );
  }

  const form = await request.formData();
  const password = String(form.get("password") || "");

  if (!password || password !== configuredPassword) {
    return showLoginPage("Incorrect password. Please try again.");
  }

  const sessionId = crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO auth_sessions (id, created_at, dashboard_ticket) VALUES (?, datetime('now'), 1)"
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

async function consumeDashboardTicket(db, sessionId) {
  const result = await db
    .prepare(
      "UPDATE auth_sessions SET dashboard_ticket = 0 WHERE id = ? AND dashboard_ticket = 1"
    )
    .bind(sessionId)
    .run();

  return Number(result.meta && result.meta.changes ? result.meta.changes : 0) > 0;
}

async function allowNextDashboardLoad(db, sessionId) {
  await db
    .prepare(
      "UPDATE auth_sessions SET dashboard_ticket = 1 WHERE id = ?"
    )
    .bind(sessionId)
    .run();
}

async function deleteSession(db, sessionId) {
  if (!sessionId) return;

  await db
    .prepare("DELETE FROM auth_sessions WHERE id = ?")
    .bind(sessionId)
    .run();
}

function clearAuthCookie() {
  return "mp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
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

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) {
      cookies[name] = decodeURIComponent(value);
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
        <span>${escapeHtml(errorMessage)}</span>
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
            <div class="brand-name">META PUBLISHER</div>
            <div class="brand-mini">COMMAND CENTER</div>
          </div>
        </div>

        <div class="login-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 10V8a5 5 0 0 0-10 0v2"/>
            <rect x="4" y="10" width="16" height="11" rx="2"/>
            <path d="M12 14v3"/>
          </svg>
        </div>

        <div class="eyebrow">SECURE ACCESS</div>

        <h1>Password Required</h1>

        <p class="login-description">
          Enter your dashboard password to access your
          Facebook publishing command center.
        </p>

        ${errorHtml}

        <form method="POST" action="/login" class="login-form">
          <label for="password">Dashboard Password</label>

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
              <svg id="eyeIcon" viewBox="0 0 24 24">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>
                <circle cx="12" cy="12" r="2.5"/>
              </svg>
            </button>
          </div>

          <button type="submit" class="login-submit">
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
        const input = document.getElementById("password");
        const icon = document.getElementById("eyeIcon");

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
      "CREATE INDEX IF NOT EXISTS idx_pages_account_id ON pages(account_id)"
    )
    .run();

  // New secure session table.
  // Automatically created on deployment.
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS auth_sessions (" +
        "id TEXT PRIMARY KEY, " +
        "created_at TEXT NOT NULL, " +
        "dashboard_ticket INTEGER NOT NULL DEFAULT 0" +
      ")"
    )
    .run();

  // Clean sessions older than 24 hours.
  await db
    .prepare(
      "DELETE FROM auth_sessions WHERE created_at < datetime('now', '-1 day')"
    )
    .run();
}

// =============================================================
// META CONFIG
// =============================================================

function getMetaConfig(env) {
  const appId = String(env.META_APP_ID || "").trim();
  const appSecret = String(env.META_APP_SECRET || "").trim();

  let graphVersion = String(env.META_GRAPH_VERSION || "").trim();

  const missing = [];

  if (!appId) missing.push("META_APP_ID");
  if (!appSecret) missing.push("META_APP_SECRET");

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
  const accountsResult = await env.DB.prepare(
    "SELECT id, facebook_user_id, account_name, created_at FROM accounts ORDER BY id ASC"
  ).all();

  const accounts = accountsResult.results || [];

  const pagesResult = await env.DB.prepare(
    "SELECT id, facebook_page_id, page_name, account_id FROM pages ORDER BY account_id ASC, page_name COLLATE NOCASE ASC"
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

        <div class="eyebrow">GET STARTED</div>

        <h3>No Facebook account connected</h3>

        <p>
          Connect your Facebook account to bring your Pages into the
          publishing command center.
        </p>

        <a class="primary-btn" href="/auth/meta">
          <span class="fb-symbol">f</span>
          Connect Facebook Account
        </a>
      </section>
    `;
  } else {
    for (const account of accounts) {
      const accountPages = groupedPages[account.id] || [];

      let pageHtml = "";

      if (accountPages.length) {
        pageHtml = `
          <div class="page-toolbar">
            <div>
              <div class="toolbar-title">Connected Pages</div>
              <div class="toolbar-subtitle">
                Select the Pages you want to publish to
              </div>
            </div>

            <div class="toolbar-actions">
              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(account.id)}, true)"
              >
                Select all
              </button>

              <button
                type="button"
                class="toolbar-btn"
                onclick="selectAccountPages(${Number(account.id)}, false)"
              >
                Clear
              </button>
            </div>
          </div>

          <div class="page-list">
        `;

        for (const p of accountPages) {
          const initial = getInitials(p.page_name || "Page");

          pageHtml += `
            <label class="page-row">
              <input
                class="page-checkbox account-${Number(account.id)}"
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

              <span class="page-avatar">${escapeHtml(initial)}</span>

              <span class="page-info">
                <span class="page-name">
                  ${escapeHtml(p.page_name || "Unnamed Page")}
                </span>

                <span class="page-id">
                  ID: ${escapeHtml(p.facebook_page_id)}
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
            <div class="no-pages-icon">!</div>
            <div>
              <strong>No Pages found</strong>
              <p>
                Click <b>Sync Pages</b> to refresh this Facebook account.
              </p>
            </div>
          </div>
        `;
      }

      const accountInitials = getInitials(
        account.account_name || "Facebook Account"
      );

      accountHtml += `
        <section class="account-card">
          <div class="account-top">
            <div class="account-identity">
              <div class="account-avatar">
                ${escapeHtml(accountInitials)}
              </div>

              <div class="account-details">
                <div class="account-name-line">
                  <h2>
                    ${escapeHtml(
                      account.account_name || "Facebook Account"
                    )}
                  </h2>

                  <span class="connected-badge">
                    <span></span>
                    Connected
                  </span>
                </div>

                <div class="facebook-id">
                  Facebook ID:
                  <code>${escapeHtml(account.facebook_user_id)}</code>
                </div>

                <div class="account-meta">
                  <span>
                    <strong>${accountPages.length}</strong>
                    Connected Page${accountPages.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </div>

            <div class="account-actions">
              <form method="POST" action="/sync">
                <input
                  type="hidden"
                  name="account_id"
                  value="${escapeHtml(account.id)}"
                />

                <button class="action-btn sync-btn" type="submit">
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
                  value="${escapeHtml(account.id)}"
                />

                <button class="action-btn remove-btn" type="submit">
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

  if (accounts.length > 0 && pages.length > 0) {
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
              <div class="eyebrow">PUBLISHING STUDIO</div>
              <h2>Create &amp; Publish</h2>
              <p>
                Compose once and publish to multiple Facebook Pages.
              </p>
            </div>
          </div>

          <div id="selected-count" class="selected-pill">
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
              <label for="message">Post Content</label>
              <span id="char-count">0 characters</span>
            </div>

            <textarea
              id="message"
              name="message"
              rows="7"
              maxlength="63206"
              placeholder="What would you like to publish today?"
            ></textarea>
          </div>

          <div class="upload-box" id="upload-box">
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

            <div id="file-name" class="file-name"></div>

            <div class="upload-hint">
              Optional &nbsp;•&nbsp; Maximum 100 MB
            </div>
          </div>

          <div class="publish-footer">
            <div class="publish-info">
              <div class="publish-info-icon">✓</div>
              <div>
                <strong>Ready to publish</strong>
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
              <span class="publish-btn-text">Publish to Pages</span>

              <svg class="publish-arrow" viewBox="0 0 24 24">
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
          document.querySelectorAll(".page-checkbox:checked");

        const counter =
          document.getElementById("selected-count");

        const targetText =
          document.getElementById("publish-target-text");

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

        document.querySelectorAll(".page-row").forEach(function(row) {
          const checkbox = row.querySelector(".page-checkbox");

          if (checkbox && checkbox.checked) {
            row.classList.add("selected");
          } else {
            row.classList.remove("selected");
          }
        });
      }

      function selectAccountPages(accountId, select) {
        document
          .querySelectorAll(".account-" + accountId)
          .forEach(function(c) {
            c.checked = select;
          });

        updateSelectedCount();
      }

      document.addEventListener("change", function(e) {
        if (
          e.target &&
          e.target.classList.contains("page-checkbox")
        ) {
          updateSelectedCount();
        }
      });

      const message =
        document.getElementById("message");

      const charCount =
        document.getElementById("char-count");

      if (message && charCount) {
        message.addEventListener("input", function() {
          charCount.textContent =
            message.value.length + " characters";
        });
      }

      const media =
        document.getElementById("media");

      const fileName =
        document.getElementById("file-name");

      const uploadBox =
        document.getElementById("upload-box");

      if (media) {
        media.addEventListener("change", function() {
          if (media.files && media.files.length) {
            fileName.textContent =
              "Selected: " + media.files[0].name;
            uploadBox.classList.add("has-file");
          } else {
            fileName.textContent = "";
            uploadBox.classList.remove("has-file");
          }
        });
      }

      if (uploadBox && media) {
        uploadBox.addEventListener("click", function(e) {
          if (e.target !== media) {
            media.click();
          }
        });
      }

      const publishForm =
        document.getElementById("publish-form");

      if (publishForm) {
        publishForm.addEventListener("submit", function(e) {
          const selected =
            document.querySelectorAll(
              ".page-checkbox:checked"
            );

          const text =
            message ? message.value.trim() : "";

          const hasMedia =
            media &&
            media.files &&
            media.files.length > 0;

          if (!selected.length) {
            e.preventDefault();
            alert("Please select at least one Facebook Page.");
            return;
          }

          if (!text && !hasMedia) {
            e.preventDefault();
            alert(
              "Please enter post text or select an image/video."
            );
            return;
          }

          const btn =
            document.getElementById("publish-btn");

          if (btn) {
            btn.classList.add("loading");
            btn.disabled = true;
          }
        });
      }

      document
        .querySelectorAll(".page-row")
        .forEach(function(row) {
          row.addEventListener("click", function(e) {
            if (
              e.target.closest("button") ||
              e.target.closest("a")
            ) {
              return;
            }

            const checkbox =
              row.querySelector(".page-checkbox");

            if (
              e.target !== checkbox &&
              !e.target.closest(".custom-check")
            ) {
              checkbox.checked = !checkbox.checked;
            }

            updateSelectedCount();
          });
        });

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
              META PUBLISHER
            </div>

            <div class="brand-mini">
              PUBLISHING COMMAND CENTER
            </div>
          </div>
        </div>

        <div class="header-actions">
          <a class="connect-account-btn" href="/auth/meta">
            <span class="plus-icon">+</span>
            Connect Facebook
          </a>

          <form method="POST" action="/logout">
            <button class="header-logout" type="submit">
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
          <span>Publishing Command Center.</span>
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
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
        </div>

        <div class="stat-data">
          <span>Total Pages</span>
          <strong>${totalPages}</strong>
          <small>Available for publishing</small>
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

function startMetaLogin(request, env, sessionId) {
  const config = getMetaConfig(env);

  const requestUrl = new URL(request.url);

  const redirectUri =
    requestUrl.origin + "/auth/meta/callback";

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const state = crypto.randomUUID();

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

async function metaCallback(request, env, sessionId) {
  const config = getMetaConfig(env);

  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription =
    url.searchParams.get("error_description");

  if (error) {
    await allowNextDashboardLoad(env.DB, sessionId);

    return page(
      "Facebook Login Error",
      `
      <div class="error-screen">
        <div class="error-box">
          <div class="error-icon">!</div>
          <div class="eyebrow">FACEBOOK AUTHENTICATION</div>
          <h2>Facebook Login Error</h2>
          <p>${escapeHtml(error)}</p>
          <p class="error-detail">
            ${escapeHtml(errorDescription || "")}
          </p>
          <a class="back-btn" href="/">
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
    url.origin + "/auth/meta/callback";

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

  const tokenResponse = await fetch(tokenUrl);

  const tokenData =
    await readGraphResponse(tokenResponse);

  if (!tokenResponse.ok || !tokenData.access_token) {
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
    encodeURIComponent(userAccessToken);

  const userResponse = await fetch(userUrl);

  const userData =
    await readGraphResponse(userResponse);

  if (!userResponse.ok || !userData.id) {
    throw new Error(
      "Could not get Facebook account information: " +
        formatGraphError(userData)
    );
  }

  await env.DB.prepare(
    "INSERT INTO accounts (facebook_user_id, account_name, access_token) VALUES (?, ?, ?) " +
      "ON CONFLICT(facebook_user_id) DO UPDATE SET " +
      "account_name=excluded.account_name, " +
      "access_token=excluded.access_token"
  )
    .bind(
      String(userData.id),
      userData.name || "Facebook Account",
      userAccessToken
    )
    .run();

  const account = await env.DB.prepare(
    "SELECT id FROM accounts WHERE facebook_user_id = ?"
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

  // OAuth callback should allow exactly one dashboard load.
  await allowNextDashboardLoad(env.DB, sessionId);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin + "/",
      "Set-Cookie":
        "meta_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store"
    }
  });
}

// =============================================================
// SYNC PAGES
// =============================================================

async function syncPages(request, env) {
  const form = await request.formData();

  const accountId =
    Number(form.get("account_id"));

  if (!accountId) {
    throw new Error("Invalid account ID.");
  }

  const account = await env.DB.prepare(
    "SELECT id, access_token FROM accounts WHERE id = ?"
  )
    .bind(accountId)
    .first();

  if (!account) {
    throw new Error("Facebook account not found.");
  }

  const config = getMetaConfig(env);

  await syncAccountPages(
    env,
    Number(account.id),
    account.access_token,
    config.graphVersion
  );

  return Response.redirect("/", 303);
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
    encodeURIComponent(userAccessToken);

  const foundPageIds = [];

  while (nextUrl) {
    const response = await fetch(nextUrl);

    const data =
      await readGraphResponse(response);

    if (!response.ok || data.error) {
      throw new Error(
        "Could not load Facebook Pages: " +
          formatGraphError(data)
      );
    }

    for (const fbPage of data.data || []) {
      if (!fbPage.id || !fbPage.access_token) {
        continue;
      }

      foundPageIds.push(String(fbPage.id));

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
          String(fbPage.id),
          fbPage.name || "Unnamed Page",
          fbPage.access_token,
          Number(accountId)
        )
        .run();
    }

    nextUrl =
      data.paging && data.paging.next
        ? data.paging.next
        : null;
  }

  if (foundPageIds.length) {
    const placeholders =
      foundPageIds.map(() => "?").join(",");

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
      "DELETE FROM pages WHERE account_id = ?"
    )
      .bind(Number(accountId))
      .run();
  }
}

// =============================================================
// REMOVE ACCOUNT
// =============================================================

async function removeAccount(request, env) {
  const form = await request.formData();

  const accountId =
    Number(form.get("account_id"));

  if (!accountId) {
    throw new Error("Invalid account ID.");
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

  return Response.redirect("/", 303);
}

// =============================================================
// PUBLISH
// =============================================================

async function publishPost(
  request,
  env,
  sessionId
) {
  const form = await request.formData();

  const message =
    String(form.get("message") || "").trim();

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
      .filter(
        id =>
          Number.isInteger(id) &&
          id > 0
      );

  if (!numericPageIds.length) {
    throw new Error(
      "Invalid selected Page IDs."
    );
  }

  const placeholders =
    numericPageIds
      .map(() => "?")
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
    mediaName = media.name;

    if (
      (media.type || "").startsWith("image/")
    ) {
      mediaType = "image";
    } else if (
      (media.type || "").startsWith("video/")
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
        pageId: fbPage.facebook_page_id,
        success: false,
        error:
          error.message ||
          String(error)
      });
    }
  }

  // The publish result page is allowed to have
  // a Back to Dashboard button without asking
  // for password again immediately.
  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  const successCount =
    results.filter(
      r => r.success
    ).length;

  const failedCount =
    results.length -
    successCount;

  let resultsHtml = "";

  for (const r of results) {
    resultsHtml += `
      <div class="result-row ${
        r.success
          ? "result-success"
          : "result-failed"
      }">

        <div class="result-main">
          <div class="result-avatar">
            ${escapeHtml(
              getInitials(
                r.page || "Page"
              )
            )}
          </div>

          <div>
            <strong>
              ${escapeHtml(
                r.page ||
                  "Unnamed Page"
              )}
            </strong>

            <div class="result-page-id">
              Page ID:
              ${escapeHtml(
                r.pageId
              )}
            </div>
          </div>
        </div>

        <div class="result-status ${
          r.success
            ? "status-success"
            : "status-failed"
        }">
          <span>
            ${r.success ? "✓" : "×"}
          </span>
          ${
            r.success
              ? "Published"
              : "Failed"
          }
        </div>

        ${
          r.success
            ? r.postId
              ? `
                <div class="result-extra success-extra">
                  Post ID:
                  ${escapeHtml(
                    r.postId
                  )}
                </div>
              `
              : ""
            : `
              <div class="result-extra">
                ${escapeHtml(
                  r.error || ""
                )}
              </div>
            `
        }

      </div>
    `;
  }

  return page(
    "Publish Results",
    `
    <div class="results-page">

      <div class="results-topbar">
        <a href="/" class="results-brand">
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

        <form method="POST" action="/logout">
          <button class="header-logout" type="submit">
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
            PUBLISHING COMPLETE
          </div>

          <h1>
            Your publishing run is finished.
          </h1>

          <p>
            The system attempted to publish your content
            across ${results.length} selected Page${
      results.length === 1 ? "" : "s"
    }.
          </p>
        </div>

        <div class="results-stats">

          <div class="result-stat success-stat">
            <span>Successful</span>
            <strong>${successCount}</strong>
          </div>

          <div class="result-stat failed-stat">
            <span>Failed</span>
            <strong>${failedCount}</strong>
          </div>

          <div class="result-stat total-stat">
            <span>Total</span>
            <strong>${results.length}</strong>
          </div>

        </div>

        <section class="results-card">
          <div class="results-card-header">
            <div>
              <div class="eyebrow">
                PAGE RESULTS
              </div>
              <h2>Publishing Report</h2>
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
          <a class="back-btn" href="/">
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
      body
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

// =============================================================
// UI HELPERS
// =============================================================

function getInitials(value) {
  const text =
    String(value || "")
      .trim();

  if (!text) {
    return "?";
  }

  const parts =
    text
      .split(/\s+/)
      .filter(Boolean);

  if (parts.length === 1) {
    return parts[0]
      .slice(0, 2)
      .toUpperCase();
  }

  return (
    parts[0][0] +
    parts[parts.length - 1][0]
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
          circle at 10% 0%,
          rgba(24, 119, 242, .12),
          transparent 30%
        ),
        radial-gradient(
          circle at 90% 10%,
          rgba(0, 191, 255, .08),
          transparent 28%
        ),
        #f5f8fc;
      color: #162033;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button,
    a {
      -webkit-tap-highlight-color: transparent;
    }

    svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ========================================================
       BRAND
       ======================================================== */

    .brand-mark {
      width: 48px;
      height: 48px;
      border-radius: 15px;
      background:
        linear-gradient(
          145deg,
          #1877f2,
          #0c55bd
        );
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 30px;
      box-shadow:
        0 12px 28px rgba(24, 119, 242, .28);
      flex: 0 0 auto;
    }

    .brand-mark span {
      transform: translateY(3px);
    }

    .brand-name {
      font-size: 13px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: .13em;
      color: inherit;
    }

    .brand-mini {
      margin-top: 6px;
      font-size: 9px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: .18em;
      opacity: .58;
    }

    .eyebrow {
      color: #1877f2;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .18em;
    }

    /* ========================================================
       LOGIN
       ======================================================== */

    .login-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px;
      position: relative;
      overflow: hidden;
      background:
        radial-gradient(
          circle at 15% 20%,
          rgba(24, 119, 242, .20),
          transparent 30%
        ),
        radial-gradient(
          circle at 85% 80%,
          rgba(0, 140, 255, .15),
          transparent 32%
        ),
        #06101d;
    }

    .login-background-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(2px);
      pointer-events: none;
    }

    .orb-one {
      width: 320px;
      height: 320px;
      top: -150px;
      left: -100px;
      background:
        radial-gradient(
          circle,
          rgba(24, 119, 242, .20),
          transparent 70%
        );
    }

    .orb-two {
      width: 380px;
      height: 380px;
      bottom: -200px;
      right: -100px;
      background:
        radial-gradient(
          circle,
          rgba(0, 191, 255, .13),
          transparent 70%
        );
    }

    .login-card {
      width: 100%;
      max-width: 470px;
      position: relative;
      z-index: 2;
      padding: 42px;
      border-radius: 26px;
      background:
        linear-gradient(
          145deg,
          rgba(19, 34, 55, .96),
          rgba(9, 21, 36, .98)
        );
      border: 1px solid rgba(255,255,255,.10);
      box-shadow:
        0 35px 100px rgba(0,0,0,.45);
      color: #fff;
    }

    .login-brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 42px;
    }

    .login-brand .brand-mini {
      color: #91a8c5;
    }

    .login-icon {
      width: 62px;
      height: 62px;
      border-radius: 19px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        rgba(24,119,242,.12);
      border: 1px solid rgba(24,119,242,.25);
      color: #4d9bff;
      margin-bottom: 22px;
    }

    .login-icon svg {
      width: 28px;
      height: 28px;
    }

    .login-card h1 {
      margin: 8px 0 12px;
      font-size: 32px;
      letter-spacing: -.04em;
    }

    .login-description {
      color: #94a7bd;
      line-height: 1.65;
      margin: 0 0 28px;
      font-size: 14px;
    }

    .login-form label {
      display: block;
      color: #d8e3f0;
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 9px;
    }

    .password-wrap {
      position: relative;
    }

    .password-wrap input {
      width: 100%;
      height: 54px;
      padding: 0 52px 0 16px;
      border-radius: 13px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.055);
      color: #fff;
      outline: none;
      transition: .2s;
    }

    .password-wrap input::placeholder {
      color: #667b95;
    }

    .password-wrap input:focus {
      border-color: rgba(24,119,242,.7);
      box-shadow:
        0 0 0 4px rgba(24,119,242,.10);
    }

    .show-password {
      position: absolute;
      right: 5px;
      top: 5px;
      width: 44px;
      height: 44px;
      border: 0;
      background: transparent;
      color: #7890ab;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .show-password svg {
      width: 19px;
      height: 19px;
    }

    .login-submit {
      width: 100%;
      height: 54px;
      border: 0;
      border-radius: 13px;
      margin-top: 14px;
      cursor: pointer;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #0d5fd2
        );
      color: #fff;
      font-weight: 900;
      box-shadow:
        0 14px 28px rgba(24,119,242,.24);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: transform .18s, box-shadow .18s;
    }

    .login-submit:hover {
      transform: translateY(-1px);
      box-shadow:
        0 18px 34px rgba(24,119,242,.30);
    }

    .login-submit svg {
      width: 18px;
    }

    .login-error {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(239,68,68,.10);
      border: 1px solid rgba(239,68,68,.20);
      color: #ff9b9b;
      font-size: 12px;
      margin-bottom: 16px;
    }

    .login-error-icon {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: rgba(239,68,68,.18);
      font-weight: 900;
    }

    .login-security {
      margin-top: 24px;
      color: #60758f;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
    }

    .security-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #36d399;
      box-shadow: 0 0 10px rgba(54,211,153,.6);
    }

    /* ========================================================
       HEADER
       ======================================================== */

    .dashboard-header {
      position: sticky;
      top: 0;
      z-index: 50;
      color: #fff;
      background:
        linear-gradient(
          105deg,
          #071426,
          #0a1c34 60%,
          #09203c
        );
      border-bottom: 1px solid rgba(255,255,255,.08);
      box-shadow:
        0 10px 30px rgba(5,15,30,.12);
    }

    .header-inner {
      max-width: 1280px;
      min-height: 76px;
      margin: auto;
      padding: 0 26px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .brand-area {
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .header-mark {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      font-size: 26px;
      box-shadow: none;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-actions form {
      margin: 0;
    }

    .connect-account-btn {
      height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 16px;
      border-radius: 11px;
      background: #1877f2;
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 900;
      box-shadow:
        0 9px 20px rgba(24,119,242,.22);
    }

    .connect-account-btn:hover {
      background: #2380f5;
    }

    .plus-icon {
      font-size: 18px;
      line-height: 1;
    }

    .header-logout {
      height: 42px;
      padding: 0 13px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,.11);
      background: rgba(255,255,255,.055);
      color: #b7c7d9;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }

    .header-logout:hover {
      color: #fff;
      background: rgba(255,255,255,.09);
    }

    .header-logout svg {
      width: 16px;
      height: 16px;
    }

    /* ========================================================
       DASHBOARD
       ======================================================== */

    .dashboard-container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 26px 70px;
    }

    .hero {
      position: relative;
      min-height: 285px;
      margin: 28px 0 22px;
      padding: 48px;
      border-radius: 27px;
      overflow: hidden;
      color: #fff;
      background:
        radial-gradient(
          circle at 85% 15%,
          rgba(24,119,242,.25),
          transparent 35%
        ),
        linear-gradient(
          125deg,
          #08172b,
          #0b2341 58%,
          #0b2b50
        );
      box-shadow:
        0 22px 55px rgba(12,32,57,.15);
    }

    .hero-glow {
      position: absolute;
      width: 450px;
      height: 450px;
      right: -180px;
      bottom: -280px;
      border-radius: 50%;
      background:
        radial-gradient(
          circle,
          rgba(24,119,242,.25),
          transparent 68%
        );
    }

    .hero-content {
      max-width: 700px;
      position: relative;
      z-index: 2;
    }

    .hero-eyebrow {
      color: #6fb0ff;
      margin-bottom: 12px;
    }

    .hero h1 {
      margin: 0;
      max-width: 720px;
      font-size: clamp(32px, 4vw, 51px);
      line-height: 1.02;
      letter-spacing: -.055em;
    }

    .hero h1 span {
      display: block;
      color: #4d9bff;
    }

    .hero p {
      max-width: 640px;
      margin: 18px 0 0;
      color: #a8bad0;
      line-height: 1.65;
      font-size: 14px;
    }

    .hero-decoration {
      position: absolute;
      right: 50px;
      top: 55px;
      width: 250px;
      height: 160px;
    }

    .floating-card {
      position: absolute;
      min-width: 145px;
      padding: 13px 15px;
      border-radius: 14px;
      background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.10);
      backdrop-filter: blur(10px);
      color: #a9bad0;
      font-size: 10px;
      font-weight: 700;
    }

    .floating-card strong {
      display: block;
      color: #fff;
      font-size: 22px;
      margin-top: 4px;
    }

    .floating-one {
      top: 5px;
      right: 0;
    }

    .floating-two {
      bottom: 0;
      left: 0;
    }

    .mini-status {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #36d399;
      margin-right: 6px;
      box-shadow:
        0 0 10px rgba(54,211,153,.7);
    }

    .mini-facebook {
      display: inline-flex;
      width: 18px;
      height: 18px;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: #1877f2;
      color: #fff;
      font-weight: 900;
      font-size: 14px;
      margin-right: 6px;
    }

    /* ========================================================
       STATS
       ======================================================== */

    .stats-grid {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 25px;
    }

    .stat-card {
      min-height: 116px;
      padding: 21px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid #e6ebf2;
      box-shadow:
        0 9px 28px rgba(18,34,55,.055);
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .stat-highlight {
      background:
        linear-gradient(
          135deg,
          #fff,
          #f4f9ff
        );
    }

    .stat-icon {
      width: 52px;
      height: 52px;
      border-radius: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .accounts-icon {
      color: #1877f2;
      background: #edf5ff;
    }

    .pages-icon {
      color: #7958e8;
      background: #f2efff;
    }

    .ready-icon {
      color: #10a879;
      background: #eafaf4;
    }

    .stat-icon svg {
      width: 24px;
      height: 24px;
    }

    .stat-data span {
      display: block;
      color: #647188;
      font-size: 11px;
      font-weight: 800;
      margin-bottom: 4px;
    }

    .stat-data strong {
      display: block;
      color: #162033;
      font-size: 27px;
      letter-spacing: -.04em;
      line-height: 1.05;
    }

    .stat-data small {
      display: block;
      color: #98a3b4;
      font-size: 10px;
      margin-top: 5px;
    }

    /* ========================================================
       ACCOUNT CARDS
       ======================================================== */

    .account-card {
      margin-bottom: 18px;
      border-radius: 20px;
      background: #fff;
      border: 1px solid #e4eaf2;
      box-shadow:
        0 10px 32px rgba(18,34,55,.055);
      overflow: hidden;
    }

    .account-top {
      padding: 23px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 1px solid #edf1f5;
    }

    .account-identity {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .account-avatar,
    .page-avatar,
    .result-avatar {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 900;
      background:
        linear-gradient(
          145deg,
          #1877f2,
          #6a55df
        );
    }

    .account-avatar {
      width: 54px;
      height: 54px;
      border-radius: 17px;
      font-size: 17px;
      box-shadow:
        0 10px 22px rgba(24,119,242,.18);
      flex: 0 0 auto;
    }

    .account-details {
      min-width: 0;
    }

    .account-name-line {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-wrap: wrap;
    }

    .account-name-line h2 {
      margin: 0;
      font-size: 17px;
      letter-spacing: -.02em;
    }

    .connected-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 8px;
      border-radius: 99px;
      color: #0d9b6f;
      background: #eafaf4;
      font-size: 9px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: .06em;
    }

    .connected-badge span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #15bd82;
    }

    .facebook-id {
      margin-top: 6px;
      color: #8b97a8;
      font-size: 10px;
    }

    .facebook-id code {
      color: #657188;
    }

    code {
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        monospace;
      word-break: break-all;
    }

    .account-meta {
      margin-top: 8px;
      color: #8793a5;
      font-size: 10px;
    }

    .account-meta strong {
      color: #3c4b61;
    }

    .account-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }

    .account-actions form {
      margin: 0;
    }

    .action-btn {
      height: 38px;
      padding: 0 12px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      font-size: 10px;
      font-weight: 900;
      border: 1px solid #e1e7ef;
      background: #fff;
    }

    .action-btn svg {
      width: 15px;
      height: 15px;
    }

    .sync-btn {
      color: #1877f2;
    }

    .sync-btn:hover {
      background: #f2f7ff;
      border-color: #c9ddfa;
    }

    .remove-btn {
      color: #d94645;
    }

    .remove-btn:hover {
      background: #fff5f5;
      border-color: #ffd4d4;
    }

    /* ========================================================
       PAGES
       ======================================================== */

    .pages-area {
      padding: 20px 23px 24px;
    }

    .page-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      margin-bottom: 13px;
    }

    .toolbar-title {
      color: #28364c;
      font-size: 12px;
      font-weight: 900;
    }

    .toolbar-subtitle {
      margin-top: 3px;
      color: #9aa5b5;
      font-size: 10px;
    }

    .toolbar-actions {
      display: flex;
      gap: 6px;
    }

    .toolbar-btn {
      height: 31px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid #e0e6ee;
      background: #f9fafc;
      color: #647188;
      font-size: 9px;
      font-weight: 900;
      cursor: pointer;
    }

    .toolbar-btn:hover {
      border-color: #bdd5f5;
      color: #1877f2;
      background: #f4f8ff;
    }

    .page-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .page-row {
      position: relative;
      min-height: 63px;
      padding: 10px 13px;
      display: flex;
      align-items: center;
      gap: 11px;
      border-radius: 12px;
      border: 1px solid #e8edf3;
      background: #fafbfd;
      cursor: pointer;
      transition:
        border-color .16s,
        background .16s,
        transform .16s,
        box-shadow .16s;
    }

    .page-row:hover {
      border-color: #c9ddf7;
      background: #f7faff;
      transform: translateY(-1px);
    }

    .page-row.selected {
      border-color: #8fbaf0;
      background:
        linear-gradient(
          90deg,
          #f3f8ff,
          #fbfdff
        );
      box-shadow:
        0 7px 20px rgba(24,119,242,.06);
    }

    .page-checkbox {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .custom-check {
      width: 19px;
      height: 19px;
      border-radius: 6px;
      border: 1.5px solid #cdd6e2;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: #fff;
      transition: .15s;
    }

    .custom-check svg {
      width: 13px;
      height: 13px;
      opacity: 0;
      transform: scale(.7);
      transition: .15s;
    }

    .page-checkbox:checked
      + .custom-check {
      background: #1877f2;
      border-color: #1877f2;
    }

    .page-checkbox:checked
      + .custom-check svg {
      opacity: 1;
      transform: scale(1);
    }

    .page-avatar {
      width: 37px;
      height: 37px;
      border-radius: 11px;
      font-size: 11px;
      flex: 0 0 auto;
    }

    .page-info {
      min-width: 0;
      flex: 1;
    }

    .page-name {
      display: block;
      color: #26344a;
      font-size: 12px;
      font-weight: 900;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-id {
      display: block;
      color: #9aa5b5;
      font-size: 9px;
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-ready {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #8490a1;
      font-size: 9px;
      font-weight: 800;
      flex: 0 0 auto;
    }

    .ready-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #2cc994;
    }

    .no-pages {
      display: flex;
      align-items: center;
      gap: 13px;
      padding: 15px;
      border-radius: 12px;
      background: #fafbfd;
      border: 1px dashed #dce3ec;
      color: #778499;
    }

    .no-pages-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      color: #d88920;
      background: #fff6e7;
      font-weight: 900;
    }

    .no-pages strong {
      color: #39475c;
      font-size: 11px;
    }

    .no-pages p {
      margin: 4px 0 0;
      font-size: 10px;
    }

    /* ========================================================
       STUDIO
       ======================================================== */

    .studio-card {
      margin-top: 24px;
      padding: 26px;
      border-radius: 22px;
      background: #fff;
      border: 1px solid #e4eaf2;
      box-shadow:
        0 13px 38px rgba(18,34,55,.065);
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
      width: 48px;
      height: 48px;
      border-radius: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #1877f2;
      background: #edf5ff;
      flex: 0 0 auto;
    }

    .studio-icon svg {
      width: 22px;
      height: 22px;
    }

    .studio-title-wrap h2 {
      margin: 4px 0 3px;
      font-size: 19px;
      letter-spacing: -.03em;
    }

    .studio-title-wrap p {
      margin: 0;
      color: #8d98a9;
      font-size: 10px;
    }

    .selected-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 33px;
      padding: 0 11px;
      border-radius: 99px;
      background: #edf5ff;
      color: #1877f2;
      font-size: 10px;
      font-weight: 900;
      white-space: nowrap;
    }

    .selected-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #1877f2;
    }

    .composer-box {
      border: 1px solid #e3e8ef;
      border-radius: 14px;
      overflow: hidden;
      background: #fbfcfe;
    }

    .composer-top {
      min-height: 44px;
      padding: 0 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e8edf3;
      background: #fff;
    }

    .composer-top label {
      color: #334259;
      font-size: 10px;
      font-weight: 900;
    }

    #char-count {
      color: #a1aaba;
      font-size: 9px;
    }

    #message {
      width: 100%;
      min-height: 145px;
      resize: vertical;
      padding: 16px;
      border: 0;
      outline: 0;
      background: transparent;
      color: #253349;
      font-size: 13px;
      line-height: 1.65;
    }

    #message::placeholder {
      color: #adb7c5;
    }

    .upload-box {
      position: relative;
      min-height: 150px;
      margin-top: 14px;
      border-radius: 15px;
      border: 1.5px dashed #cfd9e6;
      background: #fafcff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      cursor: pointer;
      overflow: hidden;
      transition: .18s;
    }

    .upload-box:hover,
    .upload-box.has-file {
      border-color: #8db9ed;
      background: #f5f9ff;
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
      width: 42px;
      height: 42px;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #1877f2;
      background: #eaf3ff;
      margin-bottom: 8px;
    }

    .upload-icon svg {
      width: 20px;
      height: 20px;
    }

    .upload-title {
      color: #36445a;
      font-size: 11px;
      font-weight: 900;
    }

    .upload-subtitle {
      color: #98a4b5;
      font-size: 9px;
      margin-top: 4px;
    }

    .upload-hint {
      color: #b0b8c5;
      font-size: 8px;
      margin-top: 9px;
    }

    .file-name {
      max-width: 80%;
      color: #1877f2;
      font-size: 9px;
      font-weight: 800;
      margin-top: 7px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .publish-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      margin-top: 18px;
    }

    .publish-info {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .publish-info-icon {
      width: 31px;
      height: 31px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      color: #0ca879;
      background: #eafaf4;
      font-size: 12px;
      font-weight: 900;
    }

    .publish-info strong {
      display: block;
      color: #39475c;
      font-size: 10px;
    }

    .publish-info span {
      display: block;
      color: #99a4b4;
      font-size: 9px;
      margin-top: 2px;
    }

    .publish-btn {
      min-width: 190px;
      height: 46px;
      border: 0;
      border-radius: 12px;
      padding: 0 17px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      color: #fff;
      background:
        linear-gradient(
          135deg,
          #1877f2,
          #0d5fd2
        );
      font-size: 10px;
      font-weight: 900;
      cursor: pointer;
      box-shadow:
        0 12px 25px rgba(24,119,242,.22);
      transition: .18s;
    }

    .publish-btn:hover {
      transform: translateY(-1px);
      box-shadow:
        0 16px 30px rgba(24,119,242,.28);
    }

    .publish-btn:disabled {
      cursor: wait;
      opacity: .82;
      transform: none;
    }

    .publish-arrow {
      width: 15px;
      height: 15px;
    }

    .publish-spinner {
      display: none;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,.35);
      border-top-color: #fff;
      animation: spin .7s linear infinite;
    }

    .publish-btn.loading
      .publish-btn-text {
      display: none;
    }

    .publish-btn.loading
      .publish-arrow {
      display: none;
    }

    .publish-btn.loading
      .publish-spinner {
      display: block;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    /* ========================================================
       EMPTY / ERROR
       ======================================================== */

    .empty-state {
      margin: 24px 0;
      padding: 60px 30px;
      text-align: center;
      border-radius: 22px;
      background: #fff;
      border: 1px solid #e4eaf2;
      box-shadow:
        0 12px 34px rgba(18,34,55,.055);
    }

    .empty-icon {
      width: 65px;
      height: 65px;
      margin: 0 auto 17px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 19px;
      color: #1877f2;
      background: #edf5ff;
    }

    .empty-icon svg {
      width: 28px;
      height: 28px;
    }

    .empty-state h3 {
      margin: 8px 0 8px;
      font-size: 21px;
      letter-spacing: -.03em;
    }

    .empty-state p {
      max-width: 470px;
      margin: 0 auto 21px;
      color: #8793a5;
      font-size: 12px;
      line-height: 1.6;
    }

    .primary-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 43px;
      padding: 0 16px;
      border-radius: 11px;
      background: #1877f2;
      color: #fff;
      text-decoration: none;
      font-size: 11px;
      font-weight: 900;
    }

    .fb-symbol {
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: rgba(255,255,255,.15);
      font-weight: 900;
      font-size: 15px;
    }

    .error-screen {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 25px;
      background: #f5f8fc;
    }

    .error-box {
      width: 100%;
      max-width: 760px;
      padding: 32px;
      border-radius: 20px;
      background: #fff;
      border: 1px solid #e3e8ef;
      box-shadow:
        0 16px 50px rgba(18,34,55,.08);
    }

    .error-icon {
      width: 45px;
      height: 45px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      background: #fff0f0;
      color: #d94141;
      font-size: 20px;
      font-weight: 900;
      margin-bottom: 17px;
    }

    .error-box h2 {
      margin: 8px 0;
      font-size: 24px;
    }

    .error-intro,
    .error-detail {
      color: #7e899a;
      font-size: 12px;
    }

    .error-box pre {
      margin-top: 18px;
      padding: 15px;
      max-height: 330px;
      overflow: auto;
      border-radius: 12px;
      background: #f7f8fa;
      color: #59667a;
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 42px;
      margin-top: 18px;
      padding: 0 15px;
      border-radius: 10px;
      background: #1877f2;
      color: #fff;
      text-decoration: none;
      font-size: 10px;
      font-weight: 900;
    }

    /* ========================================================
       RESULTS
       ======================================================== */

    .results-page {
      min-height: 100vh;
      background:
        radial-gradient(
          circle at 50% -10%,
          rgba(24,119,242,.12),
          transparent 35%
        ),
        #f5f8fc;
    }

    .results-topbar {
      min-height: 76px;
      padding: 0 26px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #081628;
      color: #fff;
    }

    .results-brand {
      display: flex;
      align-items: center;
      gap: 11px;
      color: #fff;
      text-decoration: none;
    }

    .small-mark {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      font-size: 25px;
      box-shadow: none;
    }

    .results-container {
      max-width: 950px;
      margin: 0 auto;
      padding: 60px 24px 70px;
    }

    .results-hero {
      text-align: center;
    }

    .success-big-icon {
      width: 66px;
      height: 66px;
      margin: 0 auto 18px;
      border-radius: 21px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #eafaf4;
      color: #0ca879;
      font-size: 30px;
      font-weight: 900;
    }

    .results-hero h1 {
      margin: 8px 0 10px;
      font-size: 34px;
      letter-spacing: -.045em;
    }

    .results-hero p {
      margin: 0 auto;
      max-width: 650px;
      color: #8793a5;
      font-size: 12px;
      line-height: 1.65;
    }

    .results-stats {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 32px 0 18px;
    }

    .result-stat {
      padding: 19px;
      border-radius: 15px;
      background: #fff;
      border: 1px solid #e4eaf2;
      text-align: center;
    }

    .result-stat span {
      display: block;
      color: #8c98a9;
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .08em;
    }

    .result-stat strong {
      display: block;
      margin-top: 4px;
      font-size: 25px;
    }

    .success-stat strong {
      color: #0ca879;
    }

    .failed-stat strong {
      color: #d94141;
    }

    .total-stat strong {
      color: #1877f2;
    }

    .results-card {
      padding: 22px;
      border-radius: 20px;
      background: #fff;
      border: 1px solid #e4eaf2;
      box-shadow:
        0 12px 35px rgba(18,34,55,.055);
    }

    .results-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      padding-bottom: 17px;
      border-bottom: 1px solid #edf1f5;
      margin-bottom: 14px;
    }

    .results-card-header h2 {
      margin: 5px 0 0;
      font-size: 18px;
    }

    .report-pill {
      padding: 7px 10px;
      border-radius: 99px;
      background: #edf5ff;
      color: #1877f2;
      font-size: 9px;
      font-weight: 900;
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .result-row {
      padding: 12px;
      border-radius: 12px;
      border: 1px solid #e5eaf0;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 15px;
    }

    .result-success {
      background: #fbfffd;
      border-color: #d7eee4;
    }

    .result-failed {
      background: #fffafa;
      border-color: #f1dddd;
    }

    .result-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .result-avatar {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      font-size: 9px;
      flex: 0 0 auto;
    }

    .result-main strong {
      color: #334259;
      font-size: 11px;
    }

    .result-page-id {
      margin-top: 3px;
      color: #9ba6b5;
      font-size: 8px;
    }

    .result-status {
      align-self: center;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      font-weight: 900;
    }

    .status-success {
      color: #0ca879;
    }

    .status-failed {
      color: #d94141;
    }

    .result-status span {
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: currentColor;
      color: #fff;
    }

    .result-extra {
      grid-column: 1 / -1;
      color: #7e899a;
      font-size: 9px;
      line-height: 1.5;
      word-break: break-word;
    }

    .success-extra {
      color: #5f907f;
    }

    .results-actions {
      text-align: center;
    }

    .results-actions .back-btn {
      margin-top: 22px;
    }

    /* ========================================================
       RESPONSIVE
       ======================================================== */

    @media (max-width: 980px) {
      .hero-decoration {
        opacity: .45;
        right: 15px;
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

      .action-btn {
        width: 100%;
        justify-content: center;
      }
    }

    @media (max-width: 760px) {
      .header-inner {
        min-height: auto;
        padding: 15px;
        flex-direction: column;
        align-items: stretch;
      }

      .header-actions {
        display: grid;
        grid-template-columns: 1fr auto;
      }

      .connect-account-btn {
        width: 100%;
      }

      .dashboard-container {
        padding: 0 14px 45px;
      }

      .hero {
        min-height: 300px;
        padding: 30px 24px;
        margin-top: 14px;
      }

      .hero h1 {
        font-size: 34px;
      }

      .hero-decoration {
        display: none;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .account-top {
        padding: 17px;
      }

      .account-identity {
        width: 100%;
      }

      .pages-area {
        padding: 16px;
      }

      .page-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .toolbar-actions {
        width: 100%;
      }

      .toolbar-btn {
        flex: 1;
      }

      .page-ready {
        display: none;
      }

      .studio-card {
        padding: 18px;
      }

      .studio-heading {
        align-items: flex-start;
        flex-direction: column;
      }

      .selected-pill {
        width: 100%;
        justify-content: center;
      }

      .publish-footer {
        align-items: stretch;
        flex-direction: column;
      }

      .publish-btn {
        width: 100%;
      }

      .results-topbar {
        padding: 14px 16px;
      }

      .results-container {
        padding: 40px 14px 50px;
      }

      .results-hero h1 {
        font-size: 28px;
      }

      .results-stats {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .login-page {
        padding: 15px;
      }

      .login-card {
        padding: 28px 21px;
        border-radius: 22px;
      }

      .login-card h1 {
        font-size: 27px;
      }

      .brand-mini {
        font-size: 8px;
      }

      .header-actions {
        grid-template-columns: 1fr;
      }

      .header-logout {
        width: 100%;
        justify-content: center;
      }

      .account-actions {
        display: grid;
        grid-template-columns: 1fr;
      }

      .page-row {
        padding: 9px;
      }

      .page-avatar {
        width: 34px;
        height: 34px;
      }

      .studio-title-wrap {
        align-items: flex-start;
      }

      .results-card {
        padding: 15px;
      }

      .results-card-header {
        align-items: flex-start;
        flex-direction: column;
      }

      .result-row {
        grid-template-columns: 1fr;
      }

      .result-status {
        justify-self: start;
      }
    }
  `;

  return new Response(
    "<!DOCTYPE html>" +
      '<html lang="en">' +
      "<head>" +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<meta name="robots" content="noindex,nofollow">' +
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
          "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      }
    }
  );
}

// =============================================================
// ESCAPE HTML
// =============================================================

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
      "&#39;"
    );
}
