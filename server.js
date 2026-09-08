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
        return startMetaLogin(
          request,
          env,
          auth.sessionId
        );
      }

      if (
        request.method === "GET" &&
        path === "/auth/meta/callback"
      ) {
        return metaCallback(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // SYNC
      // ---------------------------------------------------------
      if (request.method === "POST" && path === "/sync") {
        const response = await syncPages(
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
      // PUBLISH
      // ---------------------------------------------------------
      if (
        request.method === "POST" &&
        path === "/publish"
      ) {
        return publishPost(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // PUBLISH RESULTS
      // ---------------------------------------------------------
      if (
        request.method === "POST" &&
        path === "/publish-results"
      ) {
        return publishResults(
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

      return new Response(
        "Not Found",
        {
          status: 404
        }
      );
    } catch (error) {
      console.error(error);

      return page(
        "Error",
        `
        <div class="error-screen">
          <div class="error-box">
            <div class="error-icon">!</div>

            <div class="eyebrow">
              SYSTEM ERROR
            </div>

            <h2>
              Something went wrong
            </h2>

            <p class="error-intro">
              The dashboard could not complete this request.
            </p>

            <pre>${escapeHtml(
              error &&
              (error.stack || error.message)
                ? error.stack || error.message
                : String(error)
            )}</pre>

            <a
              class="back-btn"
              href="/login"
            >
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

async function getAuthenticatedSession(
  request,
  env
) {
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

  const sessionId =
    cookies.mp_session;

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


async function handleLogin(
  request,
  env
) {
  const configuredPassword =
    String(
      env.PUBLISHER_PASSWORD || ""
    ).trim();

  if (!configuredPassword) {
    return showLoginPage(
      "PUBLISHER_PASSWORD secret is not configured."
    );
  }

  const form =
    await request.formData();

  const password =
    String(
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
    "INSERT INTO auth_sessions (id, created_at, dashboard_ticket) VALUES (?, datetime('now'), 1)"
  )
    .bind(sessionId)
    .run();

  return new Response(
    null,
    {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie":
          "mp_session=" +
          encodeURIComponent(
            sessionId
          ) +
          "; Path=/; HttpOnly; Secure; SameSite=Lax",
        "Cache-Control":
          "no-store"
      }
    }
  );
}


async function consumeDashboardTicket(
  db,
  sessionId
) {
  const result =
    await db
      .prepare(
        "UPDATE auth_sessions SET dashboard_ticket = 0 WHERE id = ? AND dashboard_ticket = 1"
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
      "UPDATE auth_sessions SET dashboard_ticket = 1 WHERE id = ?"
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
    "mp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
  );
}


function handleLogout() {
  return new Response(
    null,
    {
      status: 302,
      headers: {
        Location: "/login",
        "Set-Cookie":
          clearAuthCookie(),
        "Cache-Control":
          "no-store"
      }
    }
  );
}


function parseCookies(header) {
  const cookies = {};

  for (
    const part of header.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name =
      part.slice(
        0,
        index
      ).trim();

    const value =
      part.slice(
        index + 1
      ).trim();

    if (name) {
      cookies[name] =
        decodeURIComponent(
          value
        );
    }
  }

  return cookies;
}


// =============================================================
// LOGIN PAGE
// =============================================================

function showLoginPage(
  errorMessage
) {
  const errorHtml =
    errorMessage
      ? `
      <div class="login-error">
        <span class="login-error-icon">
          !
        </span>

        <span>
          ${escapeHtml(
            errorMessage
          )}
        </span>
      </div>
      `
      : "";

  return page(
    "Password Required",
    `
    <div class="login-page">

      <div
        class="login-background-orb orb-one"
      ></div>

      <div
        class="login-background-orb orb-two"
      ></div>

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

          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M17 10V8a5 5 0 0 0-10 0v2"
            />

            <rect
              x="4"
              y="10"
              width="16"
              height="11"
              rx="2"
            />

            <path
              d="M12 14v3"
            />
          </svg>

        </div>

        <div class="eyebrow">
          SECURE ACCESS
        </div>

        <h1>
          Password Required
        </h1>

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
                <path
                  d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"
                />

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
// DATABASE
// =============================================================

async function ensureDatabaseSchema(
  db
) {
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
      "DELETE FROM auth_sessions WHERE created_at < datetime('now', '-1 day')"
    )
    .run();
}


// =============================================================
// META CONFIG
// =============================================================

function getMetaConfig(
  env
) {
  const appId =
    String(
      env.META_APP_ID || ""
    ).trim();

  const appSecret =
    String(
      env.META_APP_SECRET || ""
    ).trim();

  let graphVersion =
    String(
      env.META_GRAPH_VERSION || ""
    ).trim();

  const missing = [];

  if (!appId) {
    missing.push(
      "META_APP_ID"
    );
  }

  if (!appSecret) {
    missing.push(
      "META_APP_SECRET"
    );
  }

  if (!graphVersion) {
    graphVersion =
      "v24.0";
  }

  if (missing.length) {
    throw new Error(
      "Meta configuration is missing: " +
        missing.join(", ") +
        ". Make sure these exact names exist in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  if (
    !graphVersion.startsWith(
      "v"
    )
  ) {
    graphVersion =
      "v" +
      graphVersion;
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

async function showDashboard(
  env
) {
  const accountsResult =
    await env.DB.prepare(
      "SELECT id, facebook_user_id, account_name, created_at FROM accounts ORDER BY id ASC"
    ).all();

  const accounts =
    accountsResult.results || [];

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, account_id FROM pages ORDER BY account_id ASC, page_name COLLATE NOCASE ASC"
    ).all();

  const pages =
    pagesResult.results || [];

  const groupedPages = {};

  for (
    const account of accounts
  ) {
    groupedPages[
      account.id
    ] = [];
  }

  for (
    const p of pages
  ) {

    if (
      !groupedPages[
        p.account_id
      ]
    ) {
      groupedPages[
        p.account_id
      ] = [];
    }

    groupedPages[
      p.account_id
    ].push(p);
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
          Connect your Facebook account to bring your Pages into the
          publishing command center.
        </p>

        <a
          class="primary-btn"
          href="/auth/meta"
        >
          <span class="fb-symbol">
            f
          </span>
          Connect Facebook Account
        </a>

      </section>
    `;

  } else {

    for (
      const account of accounts
    ) {

      const accountPages =
        groupedPages[
          account.id
        ] || [];

      let pageHtml = "";

      if (
        accountPages.length
      ) {

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

        for (
          const p of accountPages
        ) {

          const initial =
            getInitials(
              p.page_name ||
                "Page"
            );

          pageHtml += `
            <label class="page-row">

              <input
                class="page-checkbox account-${Number(
                  account.id
                )}"
                type="checkbox"
                name="page_ids"
                value="${escapeHtml(
                  p.id
                )}"
                form="publish-form"
              />

              <span class="custom-check">
                <svg viewBox="0 0 24 24">
                  <path d="m5 12 4 4L19 6"/>
                </svg>
              </span>

              <span class="page-avatar">
                ${escapeHtml(
                  initial
                )}
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

        pageHtml +=
          `</div>`;

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
                Click <b>Sync Pages</b>
                to refresh this Facebook account.
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
                      accountPages.length ===
                      1
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
                Compose once and publish to multiple Facebook Pages.
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
              Optional &nbsp;•&nbsp;
              Maximum 100 MB
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

              <span
                class="publish-spinner"
              ></span>

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
            (
              checked.length === 1
                ? ""
                : "s"
            ) +
            " Selected";

        }

        if (targetText) {

          if (
            checked.length === 0
          ) {

            targetText.textContent =
              "Select one or more Pages above";

          } else {

            targetText.textContent =
              checked.length +
              " Page" +
              (
                checked.length === 1
                  ? ""
                  : "s"
              ) +
              " selected for publishing";

          }
        }

        document
          .querySelectorAll(
            ".page-row"
          )
          .forEach(
            function(row) {

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
            }
          );
      }


      function selectAccountPages(
        accountId,
        select
      ) {

        document
          .querySelectorAll(
            ".account-" +
            accountId
          )
          .forEach(
            function(c) {
              c.checked =
                select;
            }
          );

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

              fileName.textContent =
                "";

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

            if (
              e.target !== media
            ) {
              media.click();
            }

          }
        );
      }


      const publishForm =
        document.getElementById(
          "publish-form"
        );


      if (publishForm) {

        publishForm.addEventListener(
          "submit",
          async function(e) {

            const selected =
              Array.from(
                document.querySelectorAll(
                  ".page-checkbox:checked"
                )
              );

            const text =
              message
                ? message.value.trim()
                : "";

            const hasMedia =
              media &&
              media.files &&
              media.files.length >
                0;


            if (
              !selected.length
            ) {

              e.preventDefault();

              alert(
                "Please select at least one Facebook Page."
              );

              return;
            }


            if (
              !text &&
              !hasMedia
            ) {

              e.preventDefault();

              alert(
                "Please enter post content or select an image/video."
              );

              return;
            }


            const button =
              document.getElementById(
                "publish-btn"
              );

            if (button) {

              button.disabled =
                true;

              button.classList.add(
                "loading"
              );

            }

          }
        );
      }


      updateSelectedCount();

    </script>
  `;

  return page(
    APP_NAME,
    `
      <div class="dashboard-page">

        <header class="topbar">

          <div class="header-inner">

            <a
              class="header-brand"
              href="/"
            >

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

            </a>

            <div class="header-actions">

              <a
                class="connect-account-btn"
                href="/auth/meta"
              >
                <span class="fb-symbol">
                  f
                </span>
                Connect Account
              </a>

              <a
                class="header-logout"
                href="/logout"
              >
                Logout
              </a>

            </div>

          </div>

        </header>


        <main class="dashboard-container">

          <section class="hero">

            <div class="hero-content">

              <div class="eyebrow">
                META PUBLISHING PLATFORM
              </div>

              <h1>
                Facebook
                <span>
                  Command Center
                </span>
              </h1>

              <p>
                Manage connected accounts, sync Pages,
                and publish content across multiple
                Facebook Pages from one secure dashboard.
              </p>

              <div class="hero-actions">

                <a
                  class="hero-primary"
                  href="/auth/meta"
                >
                  <span class="fb-symbol">
                    f
                  </span>
                  Add Facebook Account
                </a>

              </div>

            </div>

            <div class="hero-decoration">

              <div class="hero-orbit orbit-a"></div>
              <div class="hero-orbit orbit-b"></div>

              <div class="hero-fb">
                f
              </div>

            </div>

          </section>


          <section class="stats-grid">

            <div class="stat-card">

              <div class="stat-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M19 8v6"/>
                  <path d="M22 11h-6"/>
                </svg>
              </div>

              <div>

                <span>
                  Connected Accounts
                </span>

                <strong>
                  ${totalAccounts}
                </strong>

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
                    rx="2"
                  />
                  <path d="M8 9h8"/>
                  <path d="M8 13h5"/>
                </svg>
              </div>

              <div>

                <span>
                  Connected Pages
                </span>

                <strong>
                  ${totalPages}
                </strong>

              </div>

            </div>


            <div class="stat-card">

              <div class="stat-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2v20"/>
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H15a3.5 3.5 0 0 1 0 7H7"/>
                </svg>
              </div>

              <div>

                <span>
                  Publishing Status
                </span>

                <strong>
                  Ready
                </strong>

              </div>

            </div>

          </section>


          <section class="section-heading">

            <div>

              <div class="eyebrow">
                FACEBOOK ACCOUNTS
              </div>

              <h2>
                Connected Accounts
              </h2>

            </div>

            <a
              class="section-add"
              href="/auth/meta"
            >
              + Add Account
            </a>

          </section>


          ${accountHtml}

          ${publisherHtml}

        </main>

        <footer class="dashboard-footer">
          <span>
            ${APP_NAME}
          </span>

          <span>
            Secure publishing command center
          </span>
        </footer>

      </div>

      ${script}
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
  const config =
    getMetaConfig(env);

  const url =
    new URL(
      request.url
    );

  const redirectUri =
    url.origin +
    "/auth/meta/callback";

  const scope =
    [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_read_user_content",
      "business_management"
    ].join(",");

  const state =
    crypto.randomUUID();

  await env.DB.prepare(
    "UPDATE auth_sessions SET meta_state = ? WHERE id = ?"
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
    );

  return new Response(
    null,
    {
      status: 302,
      headers: {
        Location: loginUrl,
        "Cache-Control":
          "no-store"
      }
    }
  );
}


// =============================================================
// META CALLBACK
// =============================================================

async function metaCallback(
  request,
  env,
  sessionId
) {
  const config =
    getMetaConfig(env);

  const url =
    new URL(
      request.url
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
    return page(
      "Meta Login Error",
      `
      <div class="error-screen">

        <div class="error-box">

          <div class="error-icon">
            !
          </div>

          <div class="eyebrow">
            META AUTHENTICATION
          </div>

          <h2>
            Facebook login was not completed
          </h2>

          <p class="error-intro">
            ${escapeHtml(
              errorDescription ||
                error
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

  const code =
    url.searchParams.get(
      "code"
    );

  const state =
    url.searchParams.get(
      "state"
    );

  if (!code || !state) {
    throw new Error(
      "Meta OAuth callback is missing code or state."
    );
  }

  const session =
    await env.DB.prepare(
      "SELECT id, meta_state FROM auth_sessions WHERE id = ?"
    )
      .bind(sessionId)
      .first();

  if (!session) {
    return Response.redirect(
      url.origin +
        "/login",
      302
    );
  }

  if (
    !session.meta_state ||
    session.meta_state !== state
  ) {
    throw new Error(
      "Invalid Meta OAuth state."
    );
  }

  await env.DB.prepare(
    "UPDATE auth_sessions SET meta_state = NULL WHERE id = ?"
  )
    .bind(sessionId)
    .run();

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
    await fetch(
      tokenUrl
    );

  const tokenData =
    await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    throw new Error(
      "Meta access token exchange failed: " +
        JSON.stringify(
          tokenData
        )
    );
  }

  const shortToken =
    tokenData.access_token;

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
      shortToken
    );

  const longTokenResponse =
    await fetch(
      longTokenUrl
    );

  const longTokenData =
    await longTokenResponse.json();

  const accessToken =
    longTokenResponse.ok &&
    longTokenData.access_token
      ? longTokenData.access_token
      : shortToken;

  const meResponse =
    await fetch(
      "https://graph.facebook.com/" +
        config.graphVersion +
        "/me?fields=id,name&access_token=" +
        encodeURIComponent(
          accessToken
        )
    );

  const meData =
    await meResponse.json();

  if (
    !meResponse.ok ||
    !meData.id
  ) {
    throw new Error(
      "Unable to read Facebook account information: " +
        JSON.stringify(
          meData
        )
    );
  }

  await env.DB.prepare(
    "INSERT INTO accounts (facebook_user_id, account_name, access_token) VALUES (?, ?, ?) ON CONFLICT(facebook_user_id) DO UPDATE SET account_name = excluded.account_name, access_token = excluded.access_token"
  )
    .bind(
      String(meData.id),
      String(
        meData.name ||
          "Facebook Account"
      ),
      accessToken
    )
    .run();

  const account =
    await env.DB.prepare(
      "SELECT id FROM accounts WHERE facebook_user_id = ?"
    )
      .bind(
        String(meData.id)
      )
      .first();

  if (!account) {
    throw new Error(
      "Facebook account could not be saved."
    );
  }

  await syncFacebookPagesForAccount(
    env,
    account.id,
    accessToken,
    config.graphVersion
  );

  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  return Response.redirect(
    url.origin +
      "/",
    302
  );
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
      form.get(
        "account_id"
      )
    );

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  const account =
    await env.DB.prepare(
      "SELECT id, access_token FROM accounts WHERE id = ?"
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

  await syncFacebookPagesForAccount(
    env,
    account.id,
    account.access_token,
    config.graphVersion
  );

  return Response.redirect(
    new URL(
      "/",
      request.url
    ).toString(),
    302
  );
}


async function syncFacebookPagesForAccount(
  env,
  accountId,
  accessToken,
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
      accessToken
    );

  const seen = new Set();

  while (nextUrl) {

    if (
      seen.has(nextUrl)
    ) {
      break;
    }

    seen.add(
      nextUrl
    );

    const response =
      await fetch(
        nextUrl
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        "Unable to sync Facebook Pages: " +
          JSON.stringify(
            data
          )
      );
    }

    const pageList =
      Array.isArray(
        data.data
      )
        ? data.data
        : [];

    for (
      const fbPage of pageList
    ) {

      if (
        !fbPage.id ||
        !fbPage.access_token
      ) {
        continue;
      }

      await env.DB.prepare(
        "INSERT INTO pages (facebook_page_id, page_name, access_token, account_id) VALUES (?, ?, ?, ?) ON CONFLICT(facebook_page_id) DO UPDATE SET page_name = excluded.page_name, access_token = excluded.access_token, account_id = excluded.account_id"
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
          Number(
            accountId
          )
        )
        .run();
    }

    nextUrl =
      data.paging &&
      data.paging.next
        ? data.paging.next
        : null;
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
      form.get(
        "account_id"
      )
    );

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
    new URL(
      "/",
      request.url
    ).toString(),
    302
  );
}


// =============================================================
// PUBLISH
// =============================================================

async function publishPost(
  request,
  env,
  sessionId
) {
  const form =
    await request.formData();

  const message =
    String(
      form.get("message") ||
        ""
    ).trim();

  const pageIds =
    form
      .getAll(
        "page_ids"
      )
      .map(
        value =>
          Number(value)
      )
      .filter(
        value =>
          Number.isFinite(value) &&
          value > 0
      );

  const media =
    form.get(
      "media"
    );

  if (!pageIds.length) {
    throw new Error(
      "Please select at least one Facebook Page."
    );
  }

  if (
    !message &&
    !(
      media &&
      typeof media ===
        "object" &&
      "arrayBuffer" in media &&
      media.size > 0
    )
  ) {
    throw new Error(
      "Please enter post content or select an image/video."
    );
  }

  const uniquePageIds =
    Array.from(
      new Set(
        pageIds
      )
    );

  const placeholders =
    uniquePageIds
      .map(
        () => "?"
      )
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      "SELECT id, facebook_page_id, page_name, access_token FROM pages WHERE id IN (" +
        placeholders +
        ") ORDER BY id ASC"
    )
      .bind(
        ...uniquePageIds
      )
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    throw new Error(
      "Selected Facebook Pages were not found."
    );
  }

  const config =
    getMetaConfig(env);

  const results = [];

  let mediaBytes = null;
  let mediaType = "";
  let mediaName = "";

  if (
    media &&
    typeof media ===
      "object" &&
    "arrayBuffer" in media &&
    media.size > 0
  ) {
    if (
      media.size >
      100 * 1024 * 1024
    ) {
      throw new Error(
        "Media file is larger than 100 MB."
      );
    }

    mediaBytes =
      await media.arrayBuffer();

    mediaType =
      String(
        media.type || ""
      );

    mediaName =
      String(
        media.name || ""
      );
  }

  for (
    const pageRecord of pages
  ) {

    try {

      const result =
        await publishToFacebookPage(
          config.graphVersion,
          pageRecord,
          message,
          mediaBytes,
          mediaType,
          mediaName
        );

      results.push({
        pageId:
          pageRecord.facebook_page_id,
        pageName:
          pageRecord.page_name ||
          "Facebook Page",
        success:
          true,
        postId:
          result &&
          result.id
            ? result.id
            : ""
      });

    } catch (error) {

      results.push({
        pageId:
          pageRecord.facebook_page_id,
        pageName:
          pageRecord.page_name ||
          "Facebook Page",
        success:
          false,
        error:
          error &&
          error.message
            ? error.message
            : String(error)
      });
    }
  }

  const successCount =
    results.filter(
      item =>
        item.success
    ).length;

  const failedCount =
    results.length -
    successCount;

  const payload =
    encodeURIComponent(
      JSON.stringify({
        results,
        successCount,
        failedCount,
        total:
          results.length
      })
    );

  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  return Response.redirect(
    new URL(
      "/publish-results?data=" +
        payload,
      request.url
    ).toString(),
    302
  );
}


// =============================================================
// FACEBOOK PUBLISH
// =============================================================

async function publishToFacebookPage(
  graphVersion,
  pageRecord,
  message,
  mediaBytes,
  mediaType,
  mediaName
) {
  const pageId =
    String(
      pageRecord.facebook_page_id
    );

  const accessToken =
    String(
      pageRecord.access_token
    );

  if (
    !mediaBytes
  ) {

    const response =
      await fetch(
        "https://graph.facebook.com/" +
          graphVersion +
          "/" +
          encodeURIComponent(
            pageId
          ) +
          "/feed",
        {
          method:
            "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },
          body:
            new URLSearchParams({
              message,
              access_token:
                accessToken
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        formatMetaError(
          data
        )
      );
    }

    return data;
  }


  const lowerType =
    mediaType.toLowerCase();

  const isVideo =
    lowerType.startsWith(
      "video/"
    ) ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(
      mediaName
    );

  if (isVideo) {

    const form =
      new FormData();

    form.append(
      "source",
      new Blob(
        [
          mediaBytes
        ],
        {
          type:
            mediaType ||
            "video/mp4"
        }
      ),
      mediaName ||
        "video.mp4"
    );

    form.append(
      "description",
      message
    );

    form.append(
      "access_token",
      accessToken
    );

    const response =
      await fetch(
        "https://graph.facebook.com/" +
          graphVersion +
          "/" +
          encodeURIComponent(
            pageId
          ) +
          "/videos",
        {
          method:
            "POST",
          body:
            form
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        formatMetaError(
          data
        )
      );
    }

    return data;
  }


  const form =
    new FormData();

  form.append(
    "source",
    new Blob(
      [
        mediaBytes
      ],
      {
        type:
          mediaType ||
          "image/jpeg"
      }
    ),
    mediaName ||
      "image.jpg"
  );

  if (message) {
    form.append(
      "message",
      message
    );
  }

  form.append(
    "access_token",
    accessToken
  );

  const response =
    await fetch(
      "https://graph.facebook.com/" +
        graphVersion +
        "/" +
        encodeURIComponent(
          pageId
        ) +
        "/photos",
      {
        method:
          "POST",
        body:
          form
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      formatMetaError(
        data
      )
    );
  }

  return data;
}


// =============================================================
// PUBLISH RESULTS
// =============================================================

async function publishResults(
  request,
  env,
  sessionId
) {
  const url =
    new URL(
      request.url
    );

  const raw =
    url.searchParams.get(
      "data"
    );

  let data = {
    results: [],
    successCount: 0,
    failedCount: 0,
    total: 0
  };

  if (raw) {

    try {

      data =
        JSON.parse(
          raw
        );

    } catch {
      data = {
        results: [],
        successCount: 0,
        failedCount: 0,
        total: 0
      };
    }
  }

  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  return showPublishResults(
    data
  );
}


function showPublishResults(
  data
) {
  const results =
    Array.isArray(
      data.results
    )
      ? data.results
      : [];

  const successCount =
    Number(
      data.successCount ||
        0
    );

  const failedCount =
    Number(
      data.failedCount ||
        0
    );

  const total =
    Number(
      data.total ||
        results.length
    );

  let resultHtml = "";

  if (!results.length) {

    resultHtml = `
      <div class="no-pages">
        <div class="no-pages-icon">
          !
        </div>

        <div>
          <strong>
            No publishing results
          </strong>

          <p>
            No page results were returned.
          </p>
        </div>
      </div>
    `;

  } else {

    for (
      const result of results
    ) {

      if (result.success) {

        resultHtml += `
          <div class="result-row result-success">

            <div class="result-main">

              <div class="result-avatar">
                ${escapeHtml(
                  getInitials(
                    result.pageName ||
                      "Page"
                  )
                )}
              </div>

              <div>

                <strong>
                  ${escapeHtml(
                    result.pageName ||
                      "Facebook Page"
                  )}
                </strong>

                <div class="result-page-id">
                  ID:
                  ${escapeHtml(
                    result.pageId
                  )}
                </div>

              </div>

            </div>

            <div
              class="result-status status-success"
            >
              <span>
                ✓
              </span>
              Published
            </div>

            ${
              result.postId
                ? `
                <div class="result-extra success-extra">
                  Post ID:
                  ${escapeHtml(
                    result.postId
                  )}
                </div>
              `
                : ""
            }

          </div>
        `;

      } else {

        resultHtml += `
          <div class="result-row result-failed">

            <div class="result-main">

              <div class="result-avatar">
                ${escapeHtml(
                  getInitials(
                    result.pageName ||
                      "Page"
                  )
                )}
              </div>

              <div>

                <strong>
                  ${escapeHtml(
                    result.pageName ||
                      "Facebook Page"
                  )}
                </strong>

                <div class="result-page-id">
                  ID:
                  ${escapeHtml(
                    result.pageId
                  )}
                </div>

              </div>

            </div>

            <div
              class="result-status status-failed"
            >
              <span>
                !
              </span>
              Failed
            </div>

            <div class="result-extra">
              ${escapeHtml(
                result.error ||
                  "Unknown publishing error."
              )}
            </div>

          </div>
        `;
      }
    }
  }

  return page(
    "Publishing Results",
    `
      <div class="results-page">

        <div class="results-topbar">

          <a
            class="results-brand"
            href="/"
          >

            <div class="brand-mark small-mark">
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

          </a>

          <a
            class="header-logout"
            href="/logout"
          >
            Logout
          </a>

        </div>


        <main class="results-container">

          <div class="results-hero">

            <div class="success-big-icon">
              ${
                failedCount
                  ? "!"
                  : "✓"
              }
            </div>

            <div class="eyebrow">
              PUBLISHING REPORT
            </div>

            <h1>
              ${
                failedCount
                  ? "Publishing completed with some issues"
                  : "Publishing completed"
              }
            </h1>

            <p>
              Here is the publishing result for each selected
              Facebook Page.
            </p>

          </div>


          <div class="results-stats">

            <div class="result-stat success-stat">
              <span>
                Successful
              </span>

              <strong>
                ${successCount}
              </strong>
            </div>

            <div class="result-stat failed-stat">
              <span>
                Failed
              </span>

              <strong>
                ${failedCount}
              </strong>
            </div>

            <div class="result-stat total-stat">
              <span>
                Total Pages
              </span>

              <strong>
                ${total}
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
                  Publishing Details
                </h2>

              </div>

              <div class="report-pill">
                ${successCount}
                /
                ${total}
                Successful
              </div>

            </div>

            <div class="results-list">
              ${resultHtml}
            </div>

          </section>


          <div class="results-actions">

            <a
              class="back-btn"
              href="/"
            >
              Back to Dashboard
            </a>

          </div>

        </main>

      </div>
    `
  );
}


// =============================================================
// META ERROR
// =============================================================

function formatMetaError(
  data
) {
  if (
    data &&
    data.error
  ) {

    const error =
      data.error;

    return (
      error.message ||
      error.error_user_msg ||
      JSON.stringify(
        error
      )
    );
  }

  return JSON.stringify(
    data
  );
}


// =============================================================
// HELPERS
// =============================================================

function getInitials(
  value
) {
  const text =
    String(
      value || ""
    ).trim();

  if (!text) {
    return "FB";
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
    parts[1][0]
  ).toUpperCase();
}


// =============================================================
// PAGE
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
      min-height: 100%;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      background: #f5f8fc;
      color: #142033;
      -webkit-font-smoothing: antialiased;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button,
    a {
      -webkit-tap-highlight-color:
        transparent;
    }

    svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ========================================================
       COMMON
       ======================================================== */

    .eyebrow {
      color: #1877f2;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .13em;
      text-transform: uppercase;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1877f2;
      color: #fff;
      font-size: 27px;
      font-weight: 900;
      font-family:
        Arial,
        sans-serif;
      box-shadow:
        0 8px 20px
          rgba(24,119,242,.22);
    }

    .brand-name {
      color: #fff;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    .brand-mini {
      margin-top: 2px;
      color: rgba(255,255,255,.52);
      font-size: 8px;
      font-weight: 800;
      letter-spacing: .14em;
    }

    .fb-symbol {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family:
        Arial,
        sans-serif;
      font-size: 16px;
      font-weight: 900;
    }

    /* ========================================================
       LOGIN
       ======================================================== */

    .login-page {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px;
      background:
        radial-gradient(
          circle at 15% 10%,
          rgba(24,119,242,.10),
          transparent 30%
        ),
        radial-gradient(
          circle at 90% 85%,
          rgba(13,168,121,.08),
          transparent 28%
        ),
        #f5f8fc;
    }

    .login-background-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(2px);
      pointer-events: none;
    }

    .orb-one {
      width: 300px;
      height: 300px;
      top: -160px;
      right: -80px;
      border: 1px solid
        rgba(24,119,242,.08);
    }

    .orb-two {
      width: 260px;
      height: 260px;
      bottom: -150px;
      left: -80px;
      border: 1px solid
        rgba(13,168,121,.08);
    }

    .login-card {
      position: relative;
      z-index: 1;
      width: min(100%, 430px);
      padding: 34px;
      border-radius: 26px;
      background: rgba(255,255,255,.95);
      border: 1px solid #e3e9f1;
      box-shadow:
        0 25px 70px
          rgba(17,33,53,.10);
    }

    .login-brand {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 30px;
      padding-bottom: 22px;
      border-bottom:
        1px solid #edf1f5;
    }

    .login-icon {
      width: 58px;
      height: 58px;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 17px;
      background: #edf5ff;
      color: #1877f2;
    }

    .login-icon svg {
      width: 27px;
      height: 27px;
    }

    .login-card h1 {
      margin: 7px 0 10px;
      color: #172338;
      font-size: 31px;
      letter-spacing: -.04em;
    }

    .login-description {
      margin: 0;
      color: #8995a7;
      font-size: 12px;
      line-height: 1.7;
    }

    .login-error {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-top: 17px;
      padding: 11px 12px;
      border: 1px solid #f1d8d8;
      border-radius: 11px;
      background: #fff8f8;
      color: #c53e3e;
      font-size: 10px;
      font-weight: 700;
    }

    .login-error-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: #d94141;
      color: #fff;
      font-weight: 900;
    }

    .login-form {
      margin-top: 23px;
    }

    .login-form label {
      display: block;
      margin-bottom: 8px;
      color: #526077;
      font-size: 10px;
      font-weight: 900;
    }

    .password-wrap {
      position: relative;
    }

    .password-wrap input {
      width: 100%;
      height: 49px;
      padding: 0 45px 0 14px;
      border: 1px solid #dfe6ef;
      border-radius: 11px;
      outline: none;
      background: #fbfcfe;
      color: #172338;
      font-size: 12px;
      transition:
        border .15s,
        box-shadow .15s;
    }

    .password-wrap input:focus {
      border-color: #1877f2;
      box-shadow:
        0 0 0 3px
          rgba(24,119,242,.09);
    }

    .show-password {
      position: absolute;
      top: 50%;
      right: 8px;
      width: 34px;
      height: 34px;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #8995a7;
      cursor: pointer;
    }

    .show-password:hover {
      background: #f0f4f8;
      color: #1877f2;
    }

    .show-password svg {
      width: 17px;
      height: 17px;
    }

    .login-submit {
      width: 100%;
      min-height: 49px;
      margin-top: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border: 0;
      border-radius: 11px;
      background: #1877f2;
      color: #fff;
      font-size: 11px;
      font-weight: 900;
      cursor: pointer;
      box-shadow:
        0 10px 25px
          rgba(24,119,242,.20);
    }

    .login-submit:hover {
      background: #146be0;
    }

    .login-submit svg {
      width: 16px;
      height: 16px;
    }

    .login-security {
      margin-top: 21px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      color: #9aa5b5;
      font-size: 9px;
      font-weight: 800;
    }

    .security-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #0ca879;
      box-shadow:
        0 0 0 4px
          rgba(12,168,121,.08);
    }

    /* ========================================================
       DASHBOARD
       ======================================================== */

    .dashboard-page {
      min-height: 100vh;
      background:
        radial-gradient(
          circle at 80% 0%,
          rgba(24,119,242,.055),
          transparent 25%
        ),
        #f5f8fc;
    }

    .topbar {
      background: #081628;
      color: #fff;
    }

    .header-inner {
      max-width: 1220px;
      min-height: 76px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .header-brand {
      display: flex;
      align-items: center;
      gap: 11px;
      color: #fff;
      text-decoration: none;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .connect-account-btn,
    .header-logout {
      min-height: 39px;
      padding: 0 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border-radius: 9px;
      text-decoration: none;
      font-size: 9px;
      font-weight: 900;
    }

    .connect-account-btn {
      background: #1877f2;
      color: #fff;
    }

    .header-logout {
      border: 1px solid
        rgba(255,255,255,.10);
      color: rgba(255,255,255,.68);
    }

    .header-logout:hover {
      background: rgba(255,255,255,.05);
      color: #fff;
    }

    .dashboard-container {
      max-width: 1220px;
      margin: 0 auto;
      padding: 0 24px 55px;
    }

    .hero {
      position: relative;
      min-height: 330px;
      margin-top: 20px;
      overflow: hidden;
      display: flex;
      align-items: center;
      padding: 42px 48px;
      border-radius: 25px;
      background:
        linear-gradient(
          135deg,
          #07182c,
          #0b2340
        );
      box-shadow:
        0 20px 50px
          rgba(8,22,40,.12);
    }

    .hero-content {
      position: relative;
      z-index: 2;
      max-width: 650px;
    }

    .hero .eyebrow {
      color: #73adff;
    }

    .hero h1 {
      margin: 9px 0 12px;
      color: #fff;
      font-size: 47px;
      line-height: 1.04;
      letter-spacing: -.055em;
    }

    .hero h1 span {
      color: #73adff;
    }

    .hero p {
      max-width: 600px;
      margin: 0;
      color: rgba(255,255,255,.60);
      font-size: 12px;
      line-height: 1.75;
    }

    .hero-actions {
      margin-top: 23px;
    }

    .hero-primary {
      min-height: 43px;
      padding: 0 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border-radius: 10px;
      background: #1877f2;
      color: #fff;
      text-decoration: none;
      font-size: 10px;
      font-weight: 900;
    }

    .hero-decoration {
      position: absolute;
      right: 60px;
      top: 50%;
      width: 290px;
      height: 290px;
      transform: translateY(-50%);
      opacity: .9;
    }

    .hero-orbit {
      position: absolute;
      border: 1px solid
        rgba(115,173,255,.14);
      border-radius: 50%;
    }

    .orbit-a {
      inset: 15px;
    }

    .orbit-b {
      inset: 52px;
    }

    .hero-fb {
      position: absolute;
      inset: 91px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background:
        rgba(24,119,242,.16);
      color: #73adff;
      font-family: Arial, sans-serif;
      font-size: 92px;
      font-weight: 900;
    }

    .stats-grid {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0, 1fr));
      gap: 13px;
      margin-top: 14px;
    }

    .stat-card {
      min-height: 89px;
      padding: 17px;
      display: flex;
      align-items: center;
      gap: 13px;
      border: 1px solid #e3e9f1;
      border-radius: 15px;
      background: #fff;
      box-shadow:
        0 8px 25px
          rgba(18,34,55,.035);
    }

    .stat-icon {
      width: 43px;
      height: 43px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      background: #edf5ff;
      color: #1877f2;
    }

    .stat-icon svg {
      width: 20px;
      height: 20px;
    }

    .stat-card span {
      display: block;
      color: #8c98a9;
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .05em;
      text-transform: uppercase;
    }

    .stat-card strong {
      display: block;
      margin-top: 4px;
      color: #253249;
      font-size: 20px;
      letter-spacing: -.02em;
    }

    .section-heading {
      margin: 34px 0 13px;
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 15px;
    }

    .section-heading h2 {
      margin: 5px 0 0;
      color: #1c293d;
      font-size: 21px;
      letter-spacing: -.035em;
    }

    .section-add {
      color: #1877f2;
      text-decoration: none;
      font-size: 9px;
      font-weight: 900;
    }

    .account-card {
      overflow: hidden;
      margin-bottom: 13px;
      border: 1px solid #e1e7ef;
      border-radius: 18px;
      background: #fff;
      box-shadow:
        0 10px 30px
          rgba(18,34,55,.035);
    }

    .account-top {
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .account-identity {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .account-avatar {
      width: 49px;
      height: 49px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      background: #1877f2;
      color: #fff;
      font-size: 12px;
      font-weight: 900;
    }

    .account-details {
      min-width: 0;
    }

    .account-name-line {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .account-name-line h2 {
      margin: 0;
      color: #26344a;
      font-size: 15px;
    }

    .connected-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 7px;
      border-radius: 99px;
      background: #eafaf4;
      color: #0ca879;
      font-size: 7px;
      font-weight: 900;
    }

    .connected-badge span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #0ca879;
    }

    .facebook-id {
      margin-top: 5px;
      color: #8e99a9;
      font-size: 8px;
    }

    .facebook-id code {
      color: #657185;
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }

    .account-meta {
      margin-top: 7px;
      color: #8e99a9;
      font-size: 8px;
    }

    .account-meta strong {
      color: #536077;
    }

    .account-actions {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .account-actions form {
      margin: 0;
    }

    .action-btn {
      min-height: 38px;
      padding: 0 11px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid #e2e8ef;
      border-radius: 9px;
      background: #fff;
      color: #617086;
      font-size: 8px;
      font-weight: 900;
      cursor: pointer;
    }

    .action-btn svg {
      width: 14px;
      height: 14px;
    }

    .sync-btn:hover {
      border-color: #c9ddfa;
      background: #f5f9ff;
      color: #1877f2;
    }

    .remove-btn:hover {
      border-color: #f0cccc;
      background: #fff8f8;
      color: #d94141;
    }

    .pages-area {
      padding: 18px 20px 20px;
      border-top: 1px solid #edf1f5;
      background: #fbfcfe;
    }

    .page-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      margin-bottom: 12px;
    }

    .toolbar-title {
      color: #3b4960;
      font-size: 10px;
      font-weight: 900;
    }

    .toolbar-subtitle {
      margin-top: 3px;
      color: #98a3b2;
      font-size: 8px;
    }

    .toolbar-actions {
      display: flex;
      gap: 6px;
    }

    .toolbar-btn {
      min-height: 31px;
      padding: 0 10px;
      border: 1px solid #dfe6ee;
      border-radius: 8px;
      background: #fff;
      color: #6d7889;
      font-size: 8px;
      font-weight: 900;
      cursor: pointer;
    }

    .toolbar-btn:hover {
      border-color: #c8dbf8;
      color: #1877f2;
    }

    .page-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .page-row {
      position: relative;
      min-height: 52px;
      padding: 9px 11px;
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid #e6ebf1;
      border-radius: 11px;
      background: #fff;
      cursor: pointer;
      transition:
        border .15s,
        background .15s;
    }

    .page-row:hover {
      border-color: #cfdff4;
      background: #fcfdff;
    }

    .page-row.selected {
      border-color: #aecdF6;
      background: #f6faff;
    }

    .page-checkbox {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .custom-check {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid #cbd5e1;
      border-radius: 5px;
      color: #fff;
      background: #fff;
    }

    .page-checkbox:checked +
    .custom-check {
      border-color: #1877f2;
      background: #1877f2;
    }

    .custom-check svg {
      width: 12px;
      height: 12px;
      opacity: 0;
    }

    .page-checkbox:checked +
    .custom-check svg {
      opacity: 1;
    }

    .page-avatar {
      width: 36px;
      height: 36px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: #eef4fb;
      color: #1877f2;
      font-size: 9px;
      font-weight: 900;
    }

    .page-info {
      min-width: 0;
      flex: 1;
    }

    .page-name {
      display: block;
      overflow: hidden;
      color: #405068;
      font-size: 9px;
      font-weight: 900;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-id {
      display: block;
      margin-top: 3px;
      overflow: hidden;
      color: #9ba6b5;
      font-size: 7px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-ready {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #0ca879;
      font-size: 7px;
      font-weight: 900;
    }

    .ready-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #0ca879;
    }

    .no-pages {
      min-height: 62px;
      padding: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px dashed #d9e0e8;
      border-radius: 11px;
      background: #fff;
    }

    .no-pages-icon {
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: #fff3e9;
      color: #e47a27;
      font-size: 12px;
      font-weight: 900;
    }

    .no-pages strong {
      display: block;
      color: #536077;
      font-size: 9px;
    }

    .no-pages p {
      margin: 3px 0 0;
      color: #9aa5b5;
      font-size: 8px;
    }

    .empty-state {
      padding: 50px 20px;
      text-align: center;
      border: 1px dashed #d8e1eb;
      border-radius: 18px;
      background: #fff;
    }

    .empty-icon {
      width: 60px;
      height: 60px;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 18px;
      background: #edf5ff;
      color: #1877f2;
    }

    .empty-icon svg {
      width: 27px;
      height: 27px;
    }

    .empty-state h3 {
      margin: 7px 0 7px;
      color: #2d3b51;
      font-size: 17px;
    }

    .empty-state p {
      max-width: 450px;
      margin: 0 auto 18px;
      color: #929dae;
      font-size: 10px;
      line-height: 1.65;
    }

    .primary-btn {
      min-height: 41px;
      padding: 0 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border-radius: 9px;
      background: #1877f2;
      color: #fff;
      text-decoration: none;
      font-size: 9px;
      font-weight: 900;
    }

    /* ========================================================
       PUBLISHING STUDIO
       ======================================================== */

    .studio-card {
      margin-top: 14px;
      padding: 21px;
      border: 1px solid #e1e7ef;
      border-radius: 19px;
      background: #fff;
      box-shadow:
        0 10px 30px
          rgba(18,34,55,.035);
    }

    .studio-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      margin-bottom: 18px;
    }

    .studio-title-wrap {
      display: flex;
      align-items: center;
      gap: 11px;
    }

    .studio-icon {
      width: 43px;
      height: 43px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      background: #edf5ff;
      color: #1877f2;
    }

    .studio-icon svg {
      width: 20px;
      height: 20px;
    }

    .studio-heading h2 {
      margin: 4px 0 0;
      color: #253249;
      font-size: 17px;
    }

    .studio-heading p {
      margin: 3px 0 0;
      color: #97a2b2;
      font-size: 8px;
    }

    .selected-pill {
      min-height: 31px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 99px;
      background: #f1f6fc;
      color: #657185;
      font-size: 8px;
      font-weight: 900;
    }

    .selected-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #1877f2;
    }

    .composer-box {
      overflow: hidden;
      border: 1px solid #e0e6ee;
      border-radius: 13px;
      background: #fbfcfe;
    }

    .composer-top {
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e8edf2;
    }

    .composer-top label {
      color: #526077;
      font-size: 9px;
      font-weight: 900;
    }

    .composer-top span {
      color: #a0aaba;
      font-size: 8px;
    }

    .composer-box textarea {
      width: 100%;
      min-height: 145px;
      padding: 14px;
      border: 0;
      outline: 0;
      resize: vertical;
      background: #fbfcfe;
      color: #253249;
      font-size: 11px;
      line-height: 1.65;
    }

    .composer-box textarea::placeholder {
      color: #adb6c2;
    }

    .upload-box {
      position: relative;
      min-height: 145px;
      margin-top: 11px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1px dashed #ccd8e5;
      border-radius: 13px;
      background: #fbfcfe;
      color: #8390a2;
      text-align: center;
      cursor: pointer;
    }

    .upload-box:hover,
    .upload-box.has-file {
      border-color: #a9c9f5;
      background: #f8fbff;
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
      margin-bottom: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      background: #edf5ff;
      color: #1877f2;
    }

    .upload-icon svg {
      width: 20px;
      height: 20px;
    }

    .upload-title {
      color: #536077;
      font-size: 10px;
      font-weight: 900;
    }

    .upload-subtitle {
      margin-top: 3px;
      color: #9ba6b5;
      font-size: 8px;
    }

    .file-name {
      max-width: 90%;
      margin-top: 6px;
      overflow: hidden;
      color: #1877f2;
      font-size: 8px;
      font-weight: 800;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .upload-hint {
      margin-top: 8px;
      color: #abb4c0;
      font-size: 7px;
    }

    .publish-footer {
      margin-top: 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
    }

    .publish-info {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .publish-info-icon {
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: #eafaf4;
      color: #0ca879;
      font-size: 12px;
      font-weight: 900;
    }

    .publish-info strong {
      display: block;
      color: #526077;
      font-size: 9px;
    }

    .publish-info span {
      display: block;
      margin-top: 2px;
      color: #9ba6b5;
      font-size: 7px;
    }

    .publish-btn {
      position: relative;
      min-width: 160px;
      min-height: 42px;
      padding: 0 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 0;
      border-radius: 10px;
      background: #1877f2;
      color: #fff;
      font-size: 9px;
      font-weight: 900;
      cursor: pointer;
      box-shadow:
        0 10px 25px
          rgba(24,119,242,.18);
    }

    .publish-btn:hover {
      background: #146be0;
    }

    .publish-btn:disabled {
      opacity: .72;
      cursor: wait;
    }

    .publish-spinner {
      display: none;
      width: 15px;
      height: 15px;
      border: 2px solid
        rgba(255,255,255,.35);
      border-top-color: #fff;
      border-radius: 50%;
      animation:
        spin .7s linear infinite;
    }

    .publish-btn.loading
    .publish-btn-text,
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

    .dashboard-footer {
      max-width: 1220px;
      margin: 0 auto;
      padding: 0 24px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #a2adbb;
      font-size: 7px;
      font-weight: 800;
    }

    /* ========================================================
       ERROR
       ======================================================== */

    .error-screen {
      min-height: 100vh;
      padding: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f8fc;
    }

    .error-box {
      width: min(100%, 620px);
      padding: 28px;
      border: 1px solid #eadede;
      border-radius: 20px;
      background: #fff;
      box-shadow:
        0 20px 50px
          rgba(18,34,55,.08);
    }

    .error-icon {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      background: #fff0f0;
      color: #d94141;
      font-size: 22px;
      font-weight: 900;
    }

    .error-box h2 {
      margin: 8px 0;
      color: #27344a;
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
        0 12px 35px
          rgba(18,34,55,.055);
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
      display: flex;
      align-items: center;
      justify-content: center;
      background: #eef4fb;
      color: #1877f2;
      font-weight: 900;
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
