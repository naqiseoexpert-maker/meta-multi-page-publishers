const APP_NAME = "Meta Multi Page Publisher";
const BATCH = 15;
const MAX = 100 * 1024 * 1024;

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
        return Response.redirect(
          url.origin + "/login",
          302
        );
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
          await deleteSession(
            env.DB,
            auth.sessionId
          );

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

      if (
        request.method === "GET" &&
        path === "/auth/meta"
      ) {
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

      if (
        request.method === "POST" &&
        path === "/sync"
      ) {
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
        return startPublishRun(
          request,
          env,
          auth.sessionId
        );
      }

      // ---------------------------------------------------------
      // PUBLISH BATCH
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
      // RESULTS
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
        (
          request.method === "GET" ||
          request.method === "POST"
        ) &&
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
        { status: 404 }
      );

    } catch (error) {
      console.error(error);

      return new Response(
        JSON.stringify({
          error:
            error?.message ||
            String(error)
        }),
        {
          status: 500,
          headers: {
            "Content-Type":
              "application/json; charset=UTF-8",
            "Cache-Control":
              "no-store"
          }
        }
      );
    }
  }
};


// =============================================================
// DATABASE
// =============================================================

async function ensureDatabaseSchema(DB) {

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facebook_user_id TEXT UNIQUE NOT NULL,
      account_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      facebook_page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, facebook_page_id)
    )
  `).run();

  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_pages_account
    ON pages(account_id)
  `).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      dashboard_ticket INTEGER NOT NULL DEFAULT 1
    )
  `).run();

  /*
   * Safe migration for older auth_sessions tables.
   *
   * This prevents:
   * D1_ERROR: no such column: expires_at
   *
   * if the table was created by an older version.
   */
  const authColumnsResult =
    await DB.prepare(`
      PRAGMA table_info(auth_sessions)
    `).all();

  const authColumns =
    authColumnsResult.results || [];

  const hasExpiresAt =
    authColumns.some(
      column =>
        column.name === "expires_at"
    );

  const hasDashboardTicket =
    authColumns.some(
      column =>
        column.name === "dashboard_ticket"
    );

  if (!hasExpiresAt) {
    await DB.prepare(`
      ALTER TABLE auth_sessions
      ADD COLUMN expires_at INTEGER
    `).run();

    await DB.prepare(`
      UPDATE auth_sessions
      SET expires_at = ?
      WHERE expires_at IS NULL
    `)
      .bind(
        Date.now() +
        24 * 60 * 60 * 1000
      )
      .run();
  }

  if (!hasDashboardTicket) {
    await DB.prepare(`
      ALTER TABLE auth_sessions
      ADD COLUMN dashboard_ticket INTEGER NOT NULL DEFAULT 1
    `).run();
  }

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS publish_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message TEXT,
      media_type TEXT,
      media_name TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
    )
  `).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS publish_run_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      page_id INTEGER NOT NULL,
      page_name TEXT NOT NULL,
      facebook_page_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      post_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();

  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_run_pages_run
    ON publish_run_pages(run_id)
  `).run();

  const now =
    Date.now();

  await DB.prepare(`
    DELETE FROM auth_sessions
    WHERE expires_at IS NOT NULL
    AND expires_at < ?
  `)
    .bind(now)
    .run();

  await DB.prepare(`
    DELETE FROM publish_runs
    WHERE created_at < ?
  `)
    .bind(
      now - 2 * 24 * 60 * 60 * 1000
    )
    .run();

  await DB.prepare(`
    DELETE FROM publish_run_pages
    WHERE run_id NOT IN (
      SELECT id FROM publish_runs
    )
  `).run();
}


// =============================================================
// AUTHENTICATION
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

  const configured =
    String(
      env.PUBLISHER_PASSWORD || ""
    ).trim();

  if (!configured) {
    return showLoginPage(
      "PUBLISHER_PASSWORD secret is missing."
    );
  }

  if (password !== configured) {
    return showLoginPage(
      "Incorrect password. Please try again."
    );
  }

  const sessionId =
    crypto.randomUUID();

  const now =
    Date.now();

  await env.DB.prepare(`
    INSERT INTO auth_sessions
    (id, created_at, expires_at, dashboard_ticket)
    VALUES (?, ?, ?, 1)
  `)
    .bind(
      sessionId,
      now,
      now + 24 * 60 * 60 * 1000
    )
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        setAuthCookie(sessionId),
      "Cache-Control":
        "no-store"
    }
  });
}


async function getAuthenticatedSession(
  request,
  env
) {
  const cookies =
    parseCookies(
      request.headers.get("Cookie") || ""
    );

  const sessionId =
    cookies.mp_session;

  if (!sessionId) {
    return null;
  }

  const row =
    await env.DB.prepare(`
      SELECT *
      FROM auth_sessions
      WHERE id = ?
      LIMIT 1
    `)
      .bind(sessionId)
      .first();

  if (!row) {
    return null;
  }

  if (
    Number(row.expires_at || 0) <
    Date.now()
  ) {
    await deleteSession(
      env.DB,
      sessionId
    );

    return null;
  }

  return {
    sessionId
  };
}


async function consumeDashboardTicket(
  DB,
  sessionId
) {
  const result =
    await DB.prepare(`
      UPDATE auth_sessions
      SET dashboard_ticket = 0
      WHERE id = ?
      AND dashboard_ticket = 1
    `)
      .bind(sessionId)
      .run();

  return (
    Number(result.meta?.changes || 0) >
    0
  );
}


async function allowNextDashboardLoad(
  DB,
  sessionId
) {
  await DB.prepare(`
    UPDATE auth_sessions
    SET dashboard_ticket = 1
    WHERE id = ?
  `)
    .bind(sessionId)
    .run();
}


async function deleteSession(
  DB,
  sessionId
) {
  await DB.prepare(`
    DELETE FROM auth_sessions
    WHERE id = ?
  `)
    .bind(sessionId)
    .run();
}


function setAuthCookie(
  sessionId
) {
  return [
    "mp_session=" +
      encodeURIComponent(sessionId),
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=86400"
  ].join("; ");
}


function clearAuthCookie() {
  return [
    "mp_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}


function parseCookies(
  header
) {
  const result = {};

  for (
    const part of header.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    result[key] =
      decodeURIComponent(value);
  }

  return result;
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
// META CONFIG
// =============================================================

function metaConfig(env) {
  return {
    appId:
      String(env.META_APP_ID || "")
        .trim(),

    appSecret:
      String(env.META_APP_SECRET || "")
        .trim(),

    graphVersion:
      String(
        env.META_GRAPH_VERSION ||
        "v24.0"
      ).trim()
  };
}


// =============================================================
// META LOGIN
// =============================================================

async function startMetaLogin(
  request,
  env,
  sessionId
) {
  const cfg =
    metaConfig(env);

  if (
    !cfg.appId ||
    !cfg.appSecret
  ) {
    throw new Error(
      "META_APP_ID or META_APP_SECRET is missing."
    );
  }

  const state =
    crypto.randomUUID();

  const url =
    new URL(request.url);

  const redirectUri =
    url.origin +
    "/auth/meta/callback";

  const authUrl =
    new URL(
      "https://www.facebook.com/" +
      cfg.graphVersion +
      "/dialog/oauth"
    );

  authUrl.searchParams.set(
    "client_id",
    cfg.appId
  );

  authUrl.searchParams.set(
    "redirect_uri",
    redirectUri
  );

  authUrl.searchParams.set(
    "state",
    state
  );

  authUrl.searchParams.set(
    "scope",
    [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts"
    ].join(",")
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        authUrl.toString(),

      "Set-Cookie": [
        "meta_state=" +
          encodeURIComponent(state),
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=600"
      ].join("; ")
    }
  });
}


// =============================================================
// META CALLBACK
// =============================================================

async function metaCallback(
  request,
  env,
  sessionId
) {
  const cfg =
    metaConfig(env);

  const url =
    new URL(request.url);

  const code =
    url.searchParams.get("code");

  const state =
    url.searchParams.get("state");

  const cookies =
    parseCookies(
      request.headers.get("Cookie") || ""
    );

  if (
    !code ||
    !state ||
    state !== cookies.meta_state
  ) {
    throw new Error(
      "Invalid Meta OAuth state."
    );
  }

  const redirectUri =
    url.origin +
    "/auth/meta/callback";

  const tokenUrl =
    new URL(
      "https://graph.facebook.com/" +
      cfg.graphVersion +
      "/oauth/access_token"
    );

  tokenUrl.searchParams.set(
    "client_id",
    cfg.appId
  );

  tokenUrl.searchParams.set(
    "client_secret",
    cfg.appSecret
  );

  tokenUrl.searchParams.set(
    "redirect_uri",
    redirectUri
  );

  tokenUrl.searchParams.set(
    "code",
    code
  );

  const tokenResponse =
    await fetch(
      tokenUrl.toString()
    );

  const tokenData =
    await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    throw new Error(
      tokenData.error?.message ||
      "Unable to obtain Meta access token."
    );
  }

  const userResponse =
    await fetch(
      "https://graph.facebook.com/" +
      cfg.graphVersion +
      "/me?fields=id,name&access_token=" +
      encodeURIComponent(
        tokenData.access_token
      )
    );

  const userData =
    await userResponse.json();

  if (
    !userResponse.ok ||
    !userData.id
  ) {
    throw new Error(
      userData.error?.message ||
      "Unable to load Meta account."
    );
  }

  const now =
    Date.now();

  await env.DB.prepare(`
    INSERT INTO accounts
    (
      facebook_user_id,
      account_name,
      access_token,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(facebook_user_id)
    DO UPDATE SET
      account_name = excluded.account_name,
      access_token = excluded.access_token,
      updated_at = excluded.updated_at
  `)
    .bind(
      String(userData.id),
      String(
        userData.name ||
        "Facebook Account"
      ),
      String(
        tokenData.access_token
      ),
      now,
      now
    )
    .run();

  const account =
    await env.DB.prepare(`
      SELECT *
      FROM accounts
      WHERE facebook_user_id = ?
      LIMIT 1
    `)
      .bind(
        String(userData.id)
      )
      .first();

  await syncAccount(
    env.DB,
    account.id,
    tokenData.access_token,
    cfg.graphVersion
  );

  await allowNextDashboardLoad(
    env.DB,
    sessionId
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "meta_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "Cache-Control":
        "no-store"
    }
  });
}


// =============================================================
// PAGE SYNC
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
      "Invalid account."
    );
  }

  const account =
    await env.DB.prepare(`
      SELECT *
      FROM accounts
      WHERE id = ?
      LIMIT 1
    `)
      .bind(accountId)
      .first();

  if (!account) {
    throw new Error(
      "Facebook account not found."
    );
  }

  await syncAccount(
    env.DB,
    account.id,
    account.access_token,
    metaConfig(env).graphVersion
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Cache-Control":
        "no-store"
    }
  });
}


async function syncAccount(
  DB,
  accountId,
  accessToken,
  graphVersion
) {
  const seen =
    new Set();

  let nextUrl =
    "https://graph.facebook.com/" +
    graphVersion +
    "/me/accounts?fields=id,name,access_token&limit=100&access_token=" +
    encodeURIComponent(
      accessToken
    );

  while (nextUrl) {

    const response =
      await fetch(nextUrl);

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message ||
        "Unable to sync Facebook Pages."
      );
    }

    const list =
      Array.isArray(data.data)
        ? data.data
        : [];

    for (
      const fbPage of list
    ) {
      if (
        !fbPage.id ||
        !fbPage.access_token
      ) {
        continue;
      }

      seen.add(
        String(fbPage.id)
      );

      const now =
        Date.now();

      await DB.prepare(`
        INSERT INTO pages
        (
          account_id,
          facebook_page_id,
          page_name,
          access_token,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, facebook_page_id)
        DO UPDATE SET
          page_name = excluded.page_name,
          access_token = excluded.access_token,
          updated_at = excluded.updated_at
      `)
        .bind(
          accountId,
          String(fbPage.id),
          String(
            fbPage.name ||
            "Facebook Page"
          ),
          String(
            fbPage.access_token
          ),
          now,
          now
        )
        .run();
    }

    nextUrl =
      data.paging?.next ||
      null;
  }

  const rows =
    await DB.prepare(`
      SELECT facebook_page_id
      FROM pages
      WHERE account_id = ?
    `)
      .bind(accountId)
      .all();

  const existing =
    rows.results || [];

  for (
    const row of existing
  ) {
    if (
      !seen.has(
        String(
          row.facebook_page_id
        )
      )
    ) {
      await DB.prepare(`
        DELETE FROM pages
        WHERE account_id = ?
        AND facebook_page_id = ?
      `)
        .bind(
          accountId,
          row.facebook_page_id
        )
        .run();
    }
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
      "Invalid account."
    );
  }

  await env.DB.prepare(`
    DELETE FROM pages
    WHERE account_id = ?
  `)
    .bind(accountId)
    .run();

  await env.DB.prepare(`
    DELETE FROM accounts
    WHERE id = ?
  `)
    .bind(accountId)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Cache-Control":
        "no-store"
    }
  });
}


// =============================================================
// PUBLISH RUN
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
        value => Number(value)
      )
      .filter(
        value => Number.isFinite(value)
      );

  const media =
    form.get("media");

  let mediaType =
    "";

  let mediaName =
    "";

  if (
    media &&
    typeof media === "object" &&
    typeof media.arrayBuffer === "function"
  ) {
    if (
      Number(media.size || 0) >
      MAX
    ) {
      throw new Error(
        "File is too large. Maximum supported size is 100 MB."
      );
    }

    if (
      media.size > 0
    ) {
      mediaName =
        String(
          media.name ||
          "media"
        );

      const type =
        String(
          media.type ||
          ""
        ).toLowerCase();

      if (
        type.startsWith("video/")
      ) {
        mediaType =
          "video";
      } else {
        mediaType =
          "image";
      }
    }
  }

  if (
    !message &&
    !mediaType
  ) {
    throw new Error(
      "Please enter post text or select an image/video."
    );
  }

  if (!pageIds.length) {
    throw new Error(
      "Please select at least one Facebook Page."
    );
  }

  const placeholders =
    pageIds
      .map(() => "?")
      .join(",");

  const pages =
    await env.DB.prepare(`
      SELECT *
      FROM pages
      WHERE id IN (${placeholders})
      ORDER BY id
    `)
      .bind(...pageIds)
      .all();

  const selectedPages =
    pages.results || [];

  if (
    selectedPages.length !==
    pageIds.length
  ) {
    throw new Error(
      "One or more selected Pages are no longer available."
    );
  }

  const runId =
    crypto.randomUUID();

  const now =
    Date.now();

  await env.DB.prepare(`
    INSERT INTO publish_runs
    (
      id,
      session_id,
      message,
      media_type,
      media_name,
      created_at,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, 'running')
  `)
    .bind(
      runId,
      sessionId,
      message,
      mediaType,
      mediaName,
      now
    )
    .run();

  for (
    const page of selectedPages
  ) {
    await env.DB.prepare(`
      INSERT INTO publish_run_pages
      (
        run_id,
        page_id,
        page_name,
        facebook_page_id,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `)
      .bind(
        runId,
        page.id,
        page.page_name,
        page.facebook_page_id,
        now,
        now
      )
      .run();
  }

  return json({
    ok: true,
    run_id: runId,
    total:
      selectedPages.length
  });
}


// =============================================================
// PUBLISH BATCH
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
    );

  const pageIds =
    form
      .getAll("page_ids")
      .map(
        value => Number(value)
      )
      .filter(
        value => Number.isFinite(value)
      );

  if (!runId) {
    throw new Error(
      "Missing publishing run."
    );
  }

  if (!pageIds.length) {
    throw new Error(
      "No Pages were supplied."
    );
  }

  const run =
    await env.DB.prepare(`
      SELECT *
      FROM publish_runs
      WHERE id = ?
      AND session_id = ?
      LIMIT 1
    `)
      .bind(
        runId,
        sessionId
      )
      .first();

  if (!run) {
    throw new Error(
      "Publishing run not found."
    );
  }

  const placeholders =
    pageIds
      .map(() => "?")
      .join(",");

  const pages =
    await env.DB.prepare(`
      SELECT
        prp.*,
        p.access_token
      FROM publish_run_pages prp
      JOIN pages p
        ON p.id = prp.page_id
      WHERE prp.run_id = ?
      AND prp.page_id IN (${placeholders})
      ORDER BY prp.id
      LIMIT ${BATCH}
    `)
      .bind(
        runId,
        ...pageIds
      )
      .all();

  const selected =
    pages.results || [];

  const results = [];

  let mediaBlob =
    null;

  if (
    run.media_type
  ) {
    const supplied =
      form.get("media");

    if (
      supplied &&
      typeof supplied.arrayBuffer ===
        "function" &&
      supplied.size > 0
    ) {
      mediaBlob =
        supplied;
    }
  }

  for (
    const page of selected
  ) {
    try {

      await env.DB.prepare(`
        UPDATE publish_run_pages
        SET status = 'processing',
            updated_at = ?
        WHERE id = ?
      `)
        .bind(
          Date.now(),
          page.id
        )
        .run();

      let response;

      if (
        !run.media_type
      ) {
        response =
          await publishTextPost(
            page,
            run.message || "",
            metaConfig(env).graphVersion
          );

      } else if (
        run.media_type === "image"
      ) {
        response =
          await publishMedia(
            page,
            run.message || "",
            mediaBlob,
            "image",
            metaConfig(env).graphVersion
          );

      } else {
        response =
          await publishMedia(
            page,
            run.message || "",
            mediaBlob,
            "video",
            metaConfig(env).graphVersion
          );
      }

      const postId =
        response?.id ||
        response?.post_id ||
        "";

      await env.DB.prepare(`
        UPDATE publish_run_pages
        SET status = 'success',
            post_id = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .bind(
          String(postId),
          Date.now(),
          page.id
        )
        .run();

      results.push({
        page:
          page.page_name,
        pageId:
          page.facebook_page_id,
        success:
          true,
        postId:
          String(postId)
      });

    } catch (error) {

      const errorText =
        error?.message ||
        String(error);

      await env.DB.prepare(`
        UPDATE publish_run_pages
        SET status = 'failed',
            error = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .bind(
          errorText,
          Date.now(),
          page.id
        )
        .run();

      results.push({
        page:
          page.page_name,
        pageId:
          page.facebook_page_id,
        success:
          false,
        error:
          errorText
      });
    }
  }

  const pending =
    await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM publish_run_pages
      WHERE run_id = ?
      AND status IN ('pending','processing')
    `)
      .bind(runId)
      .first();

  if (
    Number(pending?.total || 0) === 0
  ) {
    await env.DB.prepare(`
      UPDATE publish_runs
      SET status = 'completed'
      WHERE id = ?
    `)
      .bind(runId)
      .run();

    await allowNextDashboardLoad(
      env.DB,
      sessionId
    );
  }

  return json({
    ok: true,
    results
  });
}


// =============================================================
// FACEBOOK POSTING
// =============================================================

async function publishTextPost(
  page,
  message,
  graphVersion
) {
  const body =
    new URLSearchParams();

  body.set(
    "access_token",
    page.access_token
  );

  body.set(
    "message",
    message
  );

  return formGraph(
    graphVersion,
    "/" +
      page.facebook_page_id +
      "/feed",
    body
  );
}


async function publishMedia(
  page,
  message,
  file,
  type,
  graphVersion
) {
  if (
    !file ||
    typeof file.arrayBuffer !==
      "function"
  ) {
    throw new Error(
      "Media file was not supplied."
    );
  }

  const fd =
    new FormData();

  fd.append(
    "access_token",
    page.access_token
  );

  if (message) {
    fd.append(
      "message",
      message
    );
  }

  fd.append(
    "source",
    file,
    file.name ||
      "media"
  );

  return formGraph(
    graphVersion,
    "/" +
      page.facebook_page_id +
      "/" +
      (
        type === "video"
          ? "videos"
          : "photos"
      ),
    fd
  );
}


async function formGraph(
  graphVersion,
  path,
  body
) {
  const response =
    await fetch(
      "https://graph.facebook.com/" +
      graphVersion +
      path,
      {
        method: "POST",
        body
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      "Facebook API request failed."
    );
  }

  return data;
}


// =============================================================
// RESULTS
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
    );

  if (!runId) {
    throw new Error(
      "Missing publishing run."
    );
  }

  const run =
    await env.DB.prepare(`
      SELECT *
      FROM publish_runs
      WHERE id = ?
      AND session_id = ?
      LIMIT 1
    `)
      .bind(
        runId,
        sessionId
      )
      .first();

  if (!run) {
    throw new Error(
      "Publishing run not found."
    );
  }

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM publish_run_pages
      WHERE run_id = ?
      ORDER BY id
    `)
      .bind(runId)
      .all();

  const results =
    (rows.results || [])
      .map(row => ({
        page:
          row.page_name,
        pageId:
          row.facebook_page_id,
        success:
          row.status === "success",
        postId:
          row.post_id || "",
        error:
          row.error || ""
      }));

  return renderPublishResults(
    results
  );
}


function renderPublishResults(
  results
) {
  const successCount =
    results.filter(
      item => item.success
    ).length;

  const failedCount =
    results.length -
    successCount;

  let rows = "";

  for (
    const result of results
  ) {
    rows +=
      '<div class="result-row">' +

        '<div class="result-page-main">' +

          '<div class="result-page-avatar">' +
            escapeHtml(
              getInitials(
                result.page
              )
            ) +
          '</div>' +

          '<div>' +
            '<strong>' +
              escapeHtml(
                result.page
              ) +
            '</strong>' +

            '<div class="result-id">' +
              escapeHtml(
                result.pageId
              ) +
            '</div>' +

            (
              result.postId
                ? '<div class="result-post-id">Post ID: ' +
                    escapeHtml(
                      result.postId
                    ) +
                  '</div>'
                : ""
            ) +

          '</div>' +

        '</div>' +

        '<div class="' +
          (
            result.success
              ? "result-status success"
              : "result-status failed"
          ) +
        '">' +

          '<span class="status-icon">' +
            (
              result.success
                ? "✓"
                : "!"
            ) +
          '</span>' +

          (
            result.success
              ? "Published"
              : "Failed"
          ) +

        '</div>' +

        (
          result.error
            ? '<div class="result-error">' +
                escapeHtml(
                  result.error
                ) +
              '</div>'
            : ""
        ) +

      '</div>';
  }

  return page(
    "Publish Results",

    '<div class="results-page">' +

      '<div class="results-background-orb result-orb-one"></div>' +
      '<div class="results-background-orb result-orb-two"></div>' +

      '<div class="results-container">' +

        '<div class="results-topbar">' +

          '<a class="results-brand" href="/">' +

            '<div class="results-logo">' +
              'N' +
            '</div>' +

            '<div>' +
              '<div class="results-brand-mini">' +
                'NAQI SHAH' +
              '</div>' +

              '<div class="results-brand-name">' +
                'PUBLISHING COMMAND CENTER' +
              '</div>' +
            '</div>' +

          '</a>' +

          '<a class="results-back" href="/">' +
            '<span>←</span>' +
            'Dashboard' +
          '</a>' +

        '</div>' +

        '<section class="results-hero">' +

          '<div class="results-success-ring">' +
            '<div>✓</div>' +
          '</div>' +

          '<div>' +

            '<div class="results-kicker">' +
              'PUBLISHING RUN COMPLETE' +
            '</div>' +

            '<h1>Publishing Results</h1>' +

            '<p>' +
              'Your multi-page publishing operation has been processed.' +
            '</p>' +

          '</div>' +

        '</section>' +

        '<div class="results-stats">' +

          '<div class="result-stat result-stat-total">' +
            '<div class="result-stat-icon">◎</div>' +
            '<div>' +
              '<span>Total Pages</span>' +
              '<strong>' +
                results.length +
              '</strong>' +
            '</div>' +
          '</div>' +

          '<div class="result-stat result-stat-success">' +
            '<div class="result-stat-icon">✓</div>' +
            '<div>' +
              '<span>Published</span>' +
              '<strong>' +
                successCount +
              '</strong>' +
            '</div>' +
          '</div>' +

          '<div class="result-stat result-stat-failed">' +
            '<div class="result-stat-icon">!</div>' +
            '<div>' +
              '<span>Failed</span>' +
              '<strong>' +
                failedCount +
              '</strong>' +
            '</div>' +
          '</div>' +

        '</div>' +

        '<div class="results-card">' +

          '<div class="results-card-header">' +

            '<div>' +
              '<div class="results-card-kicker">' +
                'DELIVERY REPORT' +
              '</div>' +

              '<h2>Page Results</h2>' +
            '</div>' +

            '<span class="results-live">' +
              '<span></span>' +
              'RUN PROCESSED' +
            '</span>' +

          '</div>' +

          '<div class="results-list">' +
            rows +
          '</div>' +

        '</div>' +

      '</div>' +

    '</div>'
  );
}


// =============================================================
// DASHBOARD
// =============================================================

async function showDashboard(
  env
) {
  const accountsResult =
    await env.DB.prepare(`
      SELECT *
      FROM accounts
      ORDER BY account_name
    `).all();

  const pagesResult =
    await env.DB.prepare(`
      SELECT *
      FROM pages
      ORDER BY page_name
    `).all();

  const accounts =
    accountsResult.results || [];

  const pages =
    pagesResult.results || [];

  const grouped =
    new Map();

  for (
    const page of pages
  ) {
    if (
      !grouped.has(
        page.account_id
      )
    ) {
      grouped.set(
        page.account_id,
        []
      );
    }

    grouped
      .get(page.account_id)
      .push(page);
  }

  let accountHtml =
    "";

  if (!accounts.length) {

    accountHtml =
      '<section class="empty-state">' +

        '<div class="empty-visual">' +

          '<div class="empty-visual-ring"></div>' +

          '<div class="empty-visual-icon">' +
            'f' +
          '</div>' +

        '</div>' +

        '<div class="empty-kicker">' +
          'YOUR COMMAND CENTER IS READY' +
        '</div>' +

        '<h2>No Facebook Account Connected</h2>' +

        '<p>' +
          'Connect your Facebook account and bring all of your Pages into this command center.' +
        '</p>' +

        '<a class="connect-btn empty-connect" href="/auth/meta">' +
          '<span>+</span>' +
          ' Connect Facebook Account' +
        '</a>' +

      '</section>';

  } else {

    for (
      const account of accounts
    ) {

      const accountPages =
        grouped.get(
          account.id
        ) || [];

      let pageHtml =
        "";

      if (!accountPages.length) {

        pageHtml =
          '<div class="empty-pages">' +

            '<div class="empty-pages-icon">' +
              '⌁' +
            '</div>' +

            '<div>' +
              '<strong>No Pages Found</strong>' +
              '<span>Click Sync Pages to refresh your Facebook Pages.</span>' +
            '</div>' +

          '</div>';

      } else {

        pageHtml =
          '<div class="page-toolbar">' +

            '<div class="toolbar-title-wrap">' +

              '<div class="toolbar-live-dot"></div>' +

              '<div>' +
                '<div class="toolbar-title">' +
                  'CONNECTED PAGES' +
                '</div>' +

                '<div class="toolbar-subtitle">' +
                  accountPages.length +
                  ' Page' +
                  (
                    accountPages.length === 1
                      ? ""
                      : "s"
                  ) +
                  ' available for publishing' +
                '</div>' +

              '</div>' +

            '</div>' +

            '<div class="toolbar-actions">' +

              '<button class="toolbar-btn toolbar-select" type="button" onclick="selectAccountPages(' +
                account.id +
                ',true)">' +
                '<span>✓</span>' +
                ' Select All' +
              '</button>' +

              '<button class="toolbar-btn" type="button" onclick="selectAccountPages(' +
                account.id +
                ',false)">' +
                'Clear' +
              '</button>' +

            '</div>' +

          '</div>' +

          '<div class="pages-list">';

        for (
          const page of accountPages
        ) {

          const initials =
            getInitials(
              page.page_name
            );

          pageHtml +=
            '<label class="page-row">' +

              '<span class="custom-check">' +

                '<input ' +
                  'class="page-checkbox account-' +
                  escapeHtml(
                    account.id
                  ) +
                  '" ' +
                  'type="checkbox" ' +
                  'value="' +
                  escapeHtml(
                    page.id
                  ) +
                  '" />' +

                '<span class="checkmark">' +
                  '<span>✓</span>' +
                '</span>' +

              '</span>' +

              '<span class="page-avatar">' +
                escapeHtml(
                  initials
                ) +
              '</span>' +

              '<span class="page-info">' +

                '<strong>' +
                  escapeHtml(
                    page.page_name
                  ) +
                '</strong>' +

                '<small>' +
                  'ID · ' +
                  escapeHtml(
                    page.facebook_page_id
                  ) +
                '</small>' +

              '</span>' +

              '<span class="page-ready">' +
                '<span class="ready-dot"></span>' +
                'READY' +
              '</span>' +

              '<span class="page-arrow">›</span>' +

            '</label>';
        }

        pageHtml +=
          '</div>';
      }

      accountHtml +=
        '<section class="account-card">' +

          '<div class="account-top">' +

            '<div class="account-identity">' +

              '<div class="account-avatar-wrap">' +

                '<div class="account-avatar">' +
                  escapeHtml(
                    getInitials(
                      account.account_name ||
                      "Facebook Account"
                    )
                  ) +
                '</div>' +

                '<span class="account-online"></span>' +

              '</div>' +

              '<div class="account-details">' +

                '<div class="account-label">' +
                  'FACEBOOK ACCOUNT' +
                '</div>' +

                '<h2>' +
                  escapeHtml(
                    account.account_name ||
                    "Facebook Account"
                  ) +
                '</h2>' +

                '<div class="facebook-id">' +
                  '<span>ACCOUNT ID</span>' +
                  '<code>' +
                    escapeHtml(
                      account.facebook_user_id
                    ) +
                  '</code>' +
                '</div>' +

              '</div>' +

            '</div>' +

            '<div class="account-right">' +

              '<div class="account-status">' +
                '<span class="account-status-dot"></span>' +
                'CONNECTED' +
              '</div>' +

              '<div class="account-pages-count">' +
                '<strong>' +
                  accountPages.length +
                '</strong>' +
                '<span>' +
                  (
                    accountPages.length === 1
                      ? "PAGE"
                      : "PAGES"
                  ) +
                '</span>' +
              '</div>' +

              '<div class="account-actions">' +

                '<form method="POST" action="/sync">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(
                      account.id
                    ) +
                  '" />' +

                  '<button class="btn btn-blue" type="submit">' +
                    '<span class="btn-icon">↻</span>' +
                    ' Sync Pages' +
                  '</button>' +

                '</form>' +

                '<form method="POST" action="/remove-account" onsubmit="return confirm(&quot;Remove this Facebook account and all its connected Pages?&quot;);">' +

                  '<input type="hidden" name="account_id" value="' +
                    escapeHtml(
                      account.id
                    ) +
                  '" />' +

                  '<button class="btn btn-red" type="submit">' +
                    'Remove' +
                  '</button>' +

                '</form>' +

              '</div>' +

            '</div>' +

          '</div>' +

          '<div class="pages-area">' +
            pageHtml +
          '</div>' +

        '</section>';
    }
  }

  let publisherHtml =
    "";

  if (
    accounts.length &&
    pages.length
  ) {

    publisherHtml =
      '<section class="studio-card">' +

        '<div class="studio-glow studio-glow-one"></div>' +
        '<div class="studio-glow studio-glow-two"></div>' +

        '<div class="studio-heading">' +

          '<div class="studio-title-wrap">' +

            '<div class="studio-icon-wrap">' +
              '<div class="studio-icon">✦</div>' +
              '<span></span>' +
            '</div>' +

            '<div>' +

              '<div class="studio-kicker">' +
                'PUBLISHING STUDIO' +
              '</div>' +

              '<h2>Create & Publish</h2>' +

              '<p>' +
                'Craft your content and send it across your selected Facebook Pages.' +
              '</p>' +

            '</div>' +

          '</div>' +

          '<div class="selected-pill">' +

            '<span class="selected-dot"></span>' +

            '<span id="selected-count">' +
              '0 Pages Selected' +
            '</span>' +

          '</div>' +

        '</div>' +

        '<div class="studio-divider"></div>' +

        '<form id="publish-form" enctype="multipart/form-data">' +

          '<div class="field">' +

            '<div class="field-heading">' +

              '<label for="message">' +
                'Post Text' +
              '</label>' +

              '<span class="field-badge">' +
                'TEXT' +
              '</span>' +

            '</div>' +

            '<div class="textarea-shell">' +

              '<div class="textarea-decoration">' +
                'Aa' +
              '</div>' +

              '<textarea id="message" name="message" maxlength="63206" rows="7" placeholder="Write something worth sharing..."></textarea>' +

            '</div>' +

            '<div class="field-meta">' +
              '<span>Maximum 63,206 characters</span>' +
              '<span id="char-count">0 / 63,206</span>' +
            '</div>' +

          '</div>' +

          '<div class="field">' +

            '<div class="field-heading">' +

              '<label for="media">' +
                'Image / Video' +
              '</label>' +

              '<span class="field-badge field-badge-soft">' +
                'OPTIONAL' +
              '</span>' +

            '</div>' +

            '<div class="upload-box" id="upload-box">' +

              '<div class="upload-pulse"></div>' +

              '<div class="upload-icon">' +
                '↑' +
              '</div>' +

              '<strong>Drop your media here</strong>' +

              '<span>' +
                'or click to browse · JPG, PNG, WEBP, MP4 and more' +
              '</span>' +

              '<small>Maximum file size · 100 MB</small>' +

              '<input id="media" type="file" name="media" accept="image/*,video/*" />' +

            '</div>' +

          '</div>' +

          '<div class="batch-notice">' +

            '<div class="batch-icon">' +
              '⚡' +
            '</div>' +

            '<div class="batch-content">' +

              '<div class="batch-title-line">' +

                '<strong>Smart Batch Engine</strong>' +

                '<span>15 / BATCH</span>' +

              '</div>' +

              '<p>' +
                'Large publishing runs are automatically split into optimized batches of 15 Pages for reliable delivery.' +
              '</p>' +

            '</div>' +

            '<div class="batch-engine-status">' +
              '<span></span>' +
              'ONLINE' +
            '</div>' +

          '</div>' +

          '<div class="publish-footer">' +

            '<div class="publish-footer-left">' +

              '<div class="publish-shield">' +
                '✓' +
              '</div>' +

              '<div>' +
                '<strong>Publishing Engine Ready</strong>' +
                '<span>Select Pages above to begin.</span>' +
              '</div>' +

            '</div>' +

            '<button class="publish-btn" id="publish-btn" type="submit">' +

              '<span class="publish-btn-icon">➤</span>' +

              '<span class="publish-btn-text">' +
                'Publish to Selected Pages' +
              '</span>' +

              '<span class="publish-btn-arrow">→</span>' +

            '</button>' +

          '</div>' +

        '</form>' +

      '</section>';
  }

  const totalPages =
    pages.length;

  const totalAccounts =
    accounts.length;

  const totalReady =
    pages.length;

  return page(
    APP_NAME,

    '<div class="dashboard-shell">' +

      '<div class="dashboard-noise"></div>' +

      '<div class="dashboard-grid"></div>' +

      '<div class="dashboard-orb orb-left"></div>' +
      '<div class="dashboard-orb orb-right"></div>' +
      '<div class="dashboard-orb orb-bottom"></div>' +

      '<header class="hero-header">' +

        '<div class="hero-top-line">' +
          '<span></span>' +
          'COMMAND CENTER · SYSTEM ONLINE' +
          '<span></span>' +
        '</div>' +

        '<div class="hero-main">' +

          '<div class="hero-brand">' +

            '<div class="hero-kicker">' +
              'META PUBLISHING COMMAND CENTER' +
            '</div>' +

            '<div class="hero-name">' +
              'NAQI SHAH' +
            '</div>' +

            '<div class="hero-title">' +
              'Meta Multi Page Publisher' +
            '</div>' +

            '<div class="hero-subtitle">' +
              'One powerful workspace for managing Facebook accounts, Pages and large-scale content publishing.' +
            '</div>' +

            '<div class="hero-badges">' +

              '<span class="hero-badge">' +
                '<span></span>' +
                ' LIVE SYSTEM' +
              '</span>' +

              '<span class="hero-badge">' +
                '⚡ BATCH ENGINE' +
              '</span>' +

              '<span class="hero-badge">' +
                '100 MB MEDIA' +
              '</span>' +

            '</div>' +

          '</div>' +

          '<div class="hero-visual">' +

            '<div class="hero-orbit orbit-one"></div>' +
            '<div class="hero-orbit orbit-two"></div>' +

            '<div class="hero-core">' +

              '<div class="hero-core-inner">' +
                '<span>NAQI</span>' +
                '<strong>MC</strong>' +
              '</div>' +

            '</div>' +

            '<div class="hero-floating-card card-top">' +
              '<span class="mini-dot"></span>' +
              'PUBLISH' +
            '</div>' +

            '<div class="hero-floating-card card-bottom">' +
              '<span>15</span>' +
              'BATCH SIZE' +
            '</div>' +

          '</div>' +

        '</div>' +

        '<div class="header-actions">' +

          '<a class="connect-btn" href="/auth/meta">' +
            '<span class="connect-plus">+</span>' +
            '<span>Connect Facebook Account</span>' +
            '<span class="connect-arrow">→</span>' +
          '</a>' +

          '<form method="POST" action="/logout">' +
            '<button class="header-logout" type="submit">' +
              '<span>↪</span>' +
              ' Logout' +
            '</button>' +
          '</form>' +

        '</div>' +

      '</header>' +

      '<main class="container">' +

        '<section class="overview-strip">' +

          '<div class="overview-intro">' +

            '<div class="overview-kicker">' +
              'CONTROL PANEL' +
            '</div>' +

            '<h1>Publishing Overview</h1>' +

            '<p>Everything is ready from one place.</p>' +

          '</div>' +

          '<div class="overview-stats">' +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon blue">◉</div>' +
              '<div>' +
                '<span>Accounts</span>' +
                '<strong>' +
                  totalAccounts +
                '</strong>' +
              '</div>' +
            '</div>' +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon purple">▣</div>' +
              '<div>' +
                '<span>Pages</span>' +
                '<strong>' +
                  totalPages +
                '</strong>' +
              '</div>' +
            '</div>' +

            '<div class="overview-stat">' +
              '<div class="overview-stat-icon green">✓</div>' +
              '<div>' +
                '<span>Ready</span>' +
                '<strong>' +
                  totalReady +
                '</strong>' +
              '</div>' +
            '</div>' +

            '<div class="overview-stat overview-online">' +
              '<div class="overview-stat-icon cyan">⚡</div>' +
              '<div>' +
                '<span>Engine</span>' +
                '<strong>LIVE</strong>' +
              '</div>' +
            '</div>' +

          '</div>' +

        '</section>' +

        '<div class="section-heading">' +

          '<div>' +
            '<div class="section-kicker">' +
              '01 · ACCOUNTS & PAGES' +
            '</div>' +
            '<h2>Connected Accounts</h2>' +
          '</div>' +

          '<div class="section-line"></div>' +

        '</div>' +

        accountHtml +

        (
          publisherHtml
            ? (
              '<div class="section-heading studio-section-heading">' +

                '<div>' +
                  '<div class="section-kicker">' +
                    '02 · CONTENT DISTRIBUTION' +
                  '</div>' +
                  '<h2>Publishing Studio</h2>' +
                '</div>' +

                '<div class="section-line"></div>' +

              '</div>' +

              publisherHtml
            )
            : ""
        ) +

      '</main>' +

      '<footer class="dashboard-footer">' +

        '<div>' +
          '<strong>NAQI SHAH</strong>' +
          '<span> · META MULTI PAGE PUBLISHER</span>' +
        '</div>' +

        '<div class="footer-status">' +
          '<span></span>' +
          'SECURE PUBLISHING ENVIRONMENT' +
        '</div>' +

      '</footer>' +

    '</div>' +

    '<script>' +

      'const BATCH = ' +
        BATCH +
      ';' +

      'function updateSelectedCount(){' +

        'const checked=document.querySelectorAll(".page-checkbox:checked");' +

        'const counter=document.getElementById("selected-count");' +

        'const button=document.getElementById("publish-btn");' +

        'const selected=checked.length;' +

        'if(counter){counter.textContent=selected+" Page"+(selected===1?"":"s")+" Selected";}' +

        'if(button){' +
          'if(selected>0){button.classList.add("has-selection");}' +
          'else{button.classList.remove("has-selection");}' +
        '}' +

      '}' +

      'function selectAccountPages(accountId,select){' +

        'document.querySelectorAll(".account-"+accountId).forEach(function(checkbox){checkbox.checked=select;});' +

        'updateSelectedCount();' +

      '}' +

      'document.addEventListener("change",function(event){' +

        'if(event.target&&event.target.classList.contains("page-checkbox")){' +
          'updateSelectedCount();' +
        '}' +

        'if(event.target&&event.target.id==="media"){' +
          'updateMediaName();' +
        '}' +

      '});' +

      'function updateMediaName(){' +

        'const input=document.getElementById("media");' +

        'const box=document.getElementById("upload-box");' +

        'if(!input||!box)return;' +

        'const strong=box.querySelector("strong");' +

        'const spans=box.querySelectorAll("span");' +

        'const info=box.querySelector("small");' +

        'if(input.files&&input.files.length){' +

          'const file=input.files[0];' +

          'strong.textContent=file.name;' +

          'if(info){info.textContent=(file.size/1024/1024).toFixed(2)+" MB selected";}' +

          'box.classList.add("has-file");' +

        '}else{' +

          'strong.textContent="Drop your media here";' +

          'if(info){info.textContent="Maximum file size · 100 MB";}' +

          'box.classList.remove("has-file");' +

        '}' +

      '}' +

      'const message=document.getElementById("message");' +

      'if(message){' +

        'message.addEventListener("input",function(){' +

          'const count=document.getElementById("char-count");' +

          'if(count){' +
            'count.textContent=message.value.length.toLocaleString()+" / 63,206";' +
          '}' +

        '});' +

      '}' +

      'const uploadBox=document.getElementById("upload-box");' +

      'const media=document.getElementById("media");' +

      'if(uploadBox&&media){' +

        'uploadBox.addEventListener("click",function(event){' +

          'if(event.target!==media){' +
            'media.click();' +
          '}' +

        '});' +

        'uploadBox.addEventListener("dragover",function(event){' +

          'event.preventDefault();' +

          'uploadBox.classList.add("dragging");' +

        '});' +

        'uploadBox.addEventListener("dragleave",function(){' +

          'uploadBox.classList.remove("dragging");' +

        '});' +

        'uploadBox.addEventListener("drop",function(event){' +

          'event.preventDefault();' +

          'uploadBox.classList.remove("dragging");' +

          'if(event.dataTransfer&&event.dataTransfer.files&&event.dataTransfer.files.length){' +

            'try{' +
              'media.files=event.dataTransfer.files;' +
            '}catch(e){}' +

            'updateMediaName();' +

          '}' +

        '});' +

      '}' +

      'const publishForm=document.getElementById("publish-form");' +

      'if(publishForm){' +

        'publishForm.addEventListener("submit",async function(event){' +

          'event.preventDefault();' +

          'const selected=Array.from(document.querySelectorAll(".page-checkbox:checked"));' +

          'const text=message?message.value.trim():"";' +

          'const hasMedia=media&&media.files&&media.files.length>0;' +

          'const button=document.getElementById("publish-btn");' +

          'const buttonText=button?button.querySelector(".publish-btn-text"):null;' +

          'if(!selected.length){' +

            'alert("Please select at least one Facebook Page.");' +

            'return;' +

          '}' +

          'if(!text&&!hasMedia){' +

            'alert("Please enter post text or select an image/video.");' +

            'return;' +

          '}' +

          'if(hasMedia&&media.files[0].size>100*1024*1024){' +

            'alert("File is too large. Maximum supported size is 100 MB.");' +

            'return;' +

          '}' +

          'if(selected.length>15&&!confirm("You selected "+selected.length+" Pages. They will be published in batches of 15. Continue?")){' +

            'return;' +

          '}' +

          'if(button){' +

            'button.disabled=true;' +

            'button.classList.add("loading");' +

          '}' +

          'try{' +

            'const startForm=new FormData();' +

            'startForm.append("message",text);' +

            'selected.forEach(function(checkbox){' +

              'startForm.append("page_ids",checkbox.value);' +

            '});' +

            'if(hasMedia){' +

              'startForm.append("media",media.files[0],media.files[0].name);' +

            '}' +

            'const startResponse=await fetch("/publish",{method:"POST",body:startForm,credentials:"same-origin",headers:{"Accept":"application/json"}});' +

            'const startData=await startResponse.json();' +

            'if(!startResponse.ok||!startData.ok||!startData.run_id){' +

              'throw new Error(startData.error||"Unable to start publishing.");' +

            '}' +

            'const runId=startData.run_id;' +

            'for(let start=0;start<selected.length;start+=BATCH){' +

              'const batch=selected.slice(start,start+BATCH);' +

              'const batchForm=new FormData();' +

              'batchForm.append("run_id",runId);' +

              'batchForm.append("message",text);' +

              'batch.forEach(function(checkbox){' +

                'batchForm.append("page_ids",checkbox.value);' +

              '});' +

              'if(hasMedia){' +

                'batchForm.append("media",media.files[0],media.files[0].name);' +

              '}' +

              'if(buttonText){' +

                'buttonText.textContent="Publishing "+Math.min(start+BATCH,selected.length)+" / "+selected.length;' +

              '}' +

              'const response=await fetch("/publish-batch",{method:"POST",body:batchForm,credentials:"same-origin",headers:{"Accept":"application/json"}});' +

              'const data=await response.json();' +

              'if(!response.ok||!data.ok||!Array.isArray(data.results)){throw new Error(data.error||"Publishing batch failed.");}' +

            '}' +

            'window.location.href="/publish-results?run_id="+encodeURIComponent(runId);' +

          '}catch(error){' +

            'console.error(error);' +

            'if(button){' +

              'button.disabled=false;' +
              'button.classList.remove("loading");' +
            '}' +

            'if(buttonText){' +
              'buttonText.textContent="Publish to Selected Pages";' +
            '}' +

            'alert(error&&error.message?error.message:"Publishing failed. Please try again.");' +

          '}' +

        '});' +

      '}' +

      'document.querySelectorAll(".page-row").forEach(function(row){' +

        'row.addEventListener("click",function(event){' +

          'if(event.target.closest("button")||event.target.closest("a"))return;' +

          'const checkbox=row.querySelector(".page-checkbox");' +

          'if(!checkbox)return;' +

          'if(event.target!==checkbox&&!event.target.closest(".custom-check")){' +

            'checkbox.checked=!checkbox.checked;' +

          '}' +

          'updateSelectedCount();' +

        '});' +

      '});' +

      'updateSelectedCount();' +

    '</script>'
  );
}


// =============================================================
// LOGIN PAGE
// =============================================================

function showLoginPage(
  errorMessage
) {

  return page(
    "Secure Login",

    '<div class="login-page">' +

      '<div class="login-grid"></div>' +

      '<div class="login-background-orb orb-one"></div>' +
      '<div class="login-background-orb orb-two"></div>' +
      '<div class="login-background-orb orb-three"></div>' +

      '<div class="login-card">' +

        '<div class="login-top-line">' +
          '<span></span>' +
          'SECURE ACCESS' +
          '<span></span>' +
        '</div>' +

        '<div class="login-brand">' +

          '<div class="brand-mark">' +
            '<span>N</span>' +
          '</div>' +

          '<div>' +

            '<div class="brand-mini">' +
              'META PUBLISHING COMMAND CENTER' +
            '</div>' +

            '<div class="brand-name">' +
              'NAQI SHAH' +
            '</div>' +

          '</div>' +

        '</div>' +

        '<div class="login-icon">' +
          '◆' +
        '</div>' +

        '<div class="login-kicker">' +
          'PRIVATE PUBLISHING ENVIRONMENT' +
        '</div>' +

        '<h1>Welcome Back</h1>' +

        '<p class="login-description">' +
          'Enter your password to access the Meta Multi Page Publisher command center.' +
        '</p>' +

        (
          errorMessage
            ? '<div class="login-error">' +
                '<span>!</span>' +
                '<div>' +
                  escapeHtml(
                    errorMessage
                  ) +
                '</div>' +
              '</div>'
            : ""
        ) +

        '<form method="POST" action="/login">' +

          '<div class="field">' +

            '<label for="password">' +
              'Dashboard Password' +
            '</label>' +

            '<div class="password-shell">' +

              '<span class="password-icon">◆</span>' +

              '<input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required />' +

              '<span class="password-lock">●</span>' +

            '</div>' +

          '</div>' +

          '<button class="login-submit" type="submit">' +

            '<span>Enter Dashboard</span>' +
            '<strong>→</strong>' +

          '</button>' +

        '</form>' +

        '<div class="login-security">' +

          '<span class="security-dot"></span>' +

          '<span>Protected publishing environment</span>' +

          '<span class="security-divider"></span>' +

          '<span>SECURE</span>' +

        '</div>' +

      '</div>' +

      '<div class="login-footer-brand">' +
        'NAQI SHAH · META MULTI PAGE PUBLISHER' +
      '</div>' +

    '</div>'
  );
}


// =============================================================
// HTML PAGE WRAPPER + CSS
// =============================================================

function page(
  title,
  content
) {

  const css = `

/* =========================================================
   ULTRA PREMIUM COMMAND CENTER
   ========================================================= */

* {
  box-sizing: border-box;
}

html {
  background: #030712;
}

body {
  margin: 0;
  min-height: 100vh;

  position: relative;

  overflow-x: hidden;

  color: #dbeafe;

  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:
    radial-gradient(
      circle at 10% 0%,
      rgba(37,99,235,.19),
      transparent 28%
    ),
    radial-gradient(
      circle at 90% 5%,
      rgba(124,58,237,.17),
      transparent 29%
    ),
    radial-gradient(
      circle at 50% 45%,
      rgba(8,145,178,.08),
      transparent 31%
    ),
    linear-gradient(
      135deg,
      #030712 0%,
      #07111f 35%,
      #040a14 68%,
      #07101d 100%
    );

  background-attachment: fixed;
}

body::before {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

  z-index: 0;

  opacity: .35;

  background-image:
    linear-gradient(
      rgba(96,165,250,.035) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(96,165,250,.035) 1px,
      transparent 1px
    );

  background-size: 42px 42px;

  mask-image:
    linear-gradient(
      to bottom,
      black 0%,
      rgba(0,0,0,.65) 60%,
      transparent 100%
    );
}

body::after {
  content: "";

  position: fixed;

  width: 650px;
  height: 650px;

  right: -260px;
  bottom: -300px;

  border-radius: 50%;

  pointer-events: none;

  z-index: 0;

  background:
    radial-gradient(
      circle,
      rgba(37,99,235,.13),
      rgba(79,70,229,.055) 38%,
      transparent 70%
    );

  filter: blur(20px);

  animation:
    ambientFloat
    11s
    ease-in-out
    infinite
    alternate;
}

body > * {
  position: relative;
  z-index: 1;
}

@keyframes ambientFloat {
  0% {
    transform:
      translate3d(0,0,0)
      scale(1);
  }

  100% {
    transform:
      translate3d(-70px,-40px,0)
      scale(1.12);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: .45;
    transform: scale(.92);
  }

  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@keyframes shine {
  0% {
    transform: translateX(-130%);
  }

  100% {
    transform: translateX(130%);
  }
}

@keyframes riseIn {
  from {
    opacity: 0;
    transform:
      translateY(18px);
  }

  to {
    opacity: 1;
    transform:
      translateY(0);
  }
}

@media (
  prefers-reduced-motion: reduce
) {
  *,
  *::before,
  *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
  }
}

a,
button {
  -webkit-tap-highlight-color:
    transparent;
}

a {
  text-decoration: none;
}

button {
  border: 0;
  cursor: pointer;
}

/* =========================================================
   DASHBOARD BACKGROUND
   ========================================================= */

.dashboard-shell {
  min-height: 100vh;

  position: relative;

  padding-bottom: 45px;
}

.dashboard-grid {
  position: fixed;
  inset: 0;

  pointer-events: none;

  z-index: 0;

  background-image:
    linear-gradient(
      rgba(59,130,246,.025) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(59,130,246,.025) 1px,
      transparent 1px
    );

  background-size: 80px 80px;

  mask-image:
    radial-gradient(
      ellipse at center,
      black 10%,
      transparent 75%
    );
}

.dashboard-noise {
  position: fixed;
  inset: 0;

  pointer-events: none;

  z-index: 0;

  opacity: .025;

  background-image:
    url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.8'/%3E%3C/svg%3E");
}

.dashboard-orb {
  position: fixed;

  border-radius: 999px;

  pointer-events: none;

  filter: blur(80px);

  z-index: 0;

  opacity: .25;
}

.orb-left {
  width: 430px;
  height: 430px;

  left: -260px;
  top: 180px;

  background:
    #2563eb;
}

.orb-right {
  width: 370px;
  height: 370px;

  right: -210px;
  top: 480px;

  background:
    #7c3aed;
}

.orb-bottom {
  width: 450px;
  height: 250px;

  left: 35%;
  bottom: -180px;

  background:
    #0891b2;
}

/* =========================================================
   HERO
   ========================================================= */

.hero-header {
  width:
    min(
      1220px,
      calc(100% - 32px)
    );

  min-height: 460px;

  margin: 18px auto 38px;

  padding: 26px 38px 38px;

  position: relative;

  overflow: hidden;

  border:
    1px solid
    rgba(148,163,184,.14);

  border-radius: 34px;

  background:
    radial-gradient(
      circle at 78% 42%,
      rgba(37,99,235,.19),
      transparent 31%
    ),
    radial-gradient(
      circle at 93% 8%,
      rgba(139,92,246,.15),
      transparent 26%
    ),
    linear-gradient(
      135deg,
      rgba(5,15,29,.98),
      rgba(7,21,40,.96) 48%,
      rgba(7,16,31,.98)
    );

  box-shadow:
    0 40px 100px
      rgba(0,0,0,.38),
    inset 0 1px 0
      rgba(255,255,255,.045);

  backdrop-filter:
    blur(18px);

  animation:
    riseIn
    .55s
    ease
    both;
}

.hero-header::before {
  content: "";

  position: absolute;
  inset: 0;

  pointer-events: none;

  background:
    linear-gradient(
      110deg,
      transparent 0%,
      rgba(96,165,250,.045) 42%,
      transparent 70%
    );
}

.hero-header::after {
  content: "";

  position: absolute;

  width: 550px;
  height: 550px;

  right: -240px;
  top: -290px;

  border-radius: 50%;

  border:
    1px solid
    rgba(96,165,250,.09);

  box-shadow:
    0 0 0 70px
      rgba(96,165,250,.015),
    0 0 0 140px
      rgba(96,165,250,.01);
}

.hero-top-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  color:
    rgba(147,197,253,.72);

  font-size: 8px;
  font-weight: 900;

  letter-spacing: .22em;

  margin-bottom: 26px;
}

.hero-top-line span {
  width: 22px;
  height: 1px;

  background:
    rgba(96,165,250,.42);
}

.hero-main {
  display: flex;
  align-items: center;
  justify-content: space-between;

  gap: 30px;

  position: relative;
  z-index: 2;
}

.hero-brand {
  max-width: 760px;
}

.hero-kicker {
  color:
    #60a5fa;

  font-size: 10px;

  font-weight: 950;

  letter-spacing: .24em;

  margin-bottom: 11px;
}

.hero-name {
  color:
    rgba(191,219,254,.80);

  font-size: 12px;

  font-weight: 950;

  letter-spacing: .30em;

  margin-bottom: 8px;
}

.hero-title {
  font-size:
    clamp(
      34px,
      5vw,
      61px
    );

  line-height: .98;

  letter-spacing: -.055em;

  font-weight: 950;

  color: #fff;

  text-shadow:
    0 10px 50px
    rgba(37,99,235,.17);
}

.hero-subtitle {
  max-width: 650px;

  margin-top: 18px;

  color:
    rgba(203,213,225,.63);

  font-size: 13px;

  line-height: 1.7;
}

.hero-badges {
  display: flex;

  align-items: center;

  flex-wrap: wrap;

  gap: 8px;

  margin-top: 20px;
}

.hero-badge {
  min-height: 28px;

  display: inline-flex;

  align-items: center;

  gap: 7px;

  padding: 0 10px;

  border-radius: 999px;

  color:
    rgba(191,219,254,.72);

  border:
    1px solid
    rgba(96,165,250,.12);

  background:
    rgba(30,64,175,.08);

  font-size: 8px;

  font-weight: 850;

  letter-spacing: .08em;
}

.hero-badge span {
  width: 5px;
  height: 5px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 0 4px
    rgba(52,211,153,.08);

  animation:
    pulse
    2s
    ease-in-out
    infinite;
}

.hero-visual {
  width: 270px;
  height: 270px;

  flex: 0 0 auto;

  position: relative;

  display: flex;
  align-items: center;
  justify-content: center;
}

.hero-core {
  width: 130px;
  height: 130px;

  border-radius: 50%;

  padding: 1px;

  background:
    conic-gradient(
      from 0deg,
      #2563eb,
      #38bdf8,
      #7c3aed,
      #2563eb
    );

  animation:
    rotate
    9s
    linear
    infinite;

  box-shadow:
    0 0 55px
      rgba(37,99,235,.22);
}

.hero-core-inner {
  width: 100%;
  height: 100%;

  border-radius: 50%;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  background:
    radial-gradient(
      circle,
      #12284a,
      #050d1b 72%
    );

  animation:
    rotateReverse
    9s
    linear
    infinite;
}

@keyframes rotateReverse {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(-360deg);
  }
}

.hero-core-inner span {
  color:
    #60a5fa;

  font-size: 9px;

  font-weight: 950;

  letter-spacing: .25em;
}

.hero-core-inner strong {
  margin-top: 3px;

  color: #fff;

  font-size: 27px;

  font-weight: 950;

  letter-spacing: -.06em;
}

.hero-orbit {
  position: absolute;

  border-radius: 50%;

  border:
    1px solid
    rgba(96,165,250,.12);
}

.orbit-one {
  width: 190px;
  height: 190px;

  animation:
    rotate
    14s
    linear
    infinite;
}

.orbit-two {
  width: 245px;
  height: 245px;

  border-color:
    rgba(129,140,248,.08);

  animation:
    rotateReverse
    18s
    linear
    infinite;
}

.hero-floating-card {
  position: absolute;

  padding: 8px 11px;

  border-radius: 10px;

  border:
    1px solid
    rgba(148,163,184,.13);

  background:
    rgba(15,30,52,.78);

  box-shadow:
    0 15px 35px
      rgba(0,0,0,.25);

  backdrop-filter:
    blur(12px);

  color:
    rgba(219,234,254,.74);

  font-size: 8px;

  font-weight: 900;

  letter-spacing: .09em;
}

.card-top {
  right: 0;
  top: 32px;
}

.mini-dot {
  width: 5px;
  height: 5px;

  display: inline-block;

  border-radius: 50%;

  margin-right: 5px;

  background:
    #34d399;
}

.card-bottom {
  left: -2px;
  bottom: 38px;
}

.card-bottom span {
  color:
    #60a5fa;

  font-size: 14px;

  margin-right: 4px;
}

.header-actions {
  display: flex;

  align-items: center;

  justify-content: flex-end;

  gap: 10px;

  position: relative;

  z-index: 4;

  margin-top: 22px;
}

.header-actions form {
  margin: 0;
}

.connect-btn {
  min-height: 48px;

  padding: 0 15px 0 8px;

  display: inline-flex;

  align-items: center;

  gap: 9px;

  border:
    1px solid
    rgba(96,165,250,.20);

  border-radius: 14px;

  color: #fff;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #2563eb 55%,
      #4f46e5
    );

  box-shadow:
    0 15px 38px
      rgba(37,99,235,.24);

  font-size: 11px;

  font-weight: 900;

  transition:
    transform .2s ease,
    box-shadow .2s ease;
}

.connect-btn:hover {
  transform:
    translateY(-3px);

  box-shadow:
    0 21px 46px
      rgba(37,99,235,.34);
}

.connect-plus {
  width: 32px;
  height: 32px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 9px;

  background:
    rgba(255,255,255,.14);

  font-size: 18px;
}

.connect-arrow {
  margin-left: 4px;

  opacity: .62;

  font-size: 15px;
}

.header-logout {
  min-height: 48px;

  padding: 0 14px;

  border-radius: 14px;

  color:
    rgba(226,232,240,.74);

  border:
    1px solid
    rgba(148,163,184,.13);

  background:
    rgba(15,23,42,.58);

  font-size: 11px;

  font-weight: 850;

  transition:
    background .18s ease,
    color .18s ease,
    transform .18s ease;
}

.header-logout:hover {
  color: #fff;

  background:
    rgba(30,41,59,.90);

  transform:
    translateY(-2px);
}

/* =========================================================
   MAIN CONTAINER
   ========================================================= */

.container {
  width:
    min(
      1160px,
      calc(100% - 32px)
    );

  margin: 0 auto;
}

/* =========================================================
   OVERVIEW
   ========================================================= */

.overview-strip {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 20px;

  margin-bottom: 38px;

  padding: 18px 20px;

  border:
    1px solid
    rgba(148,163,184,.10);

  border-radius: 20px;

  background:
    linear-gradient(
      135deg,
      rgba(15,28,48,.70),
      rgba(7,18,33,.58)
    );

  box-shadow:
    0 18px 45px
      rgba(0,0,0,.18);

  backdrop-filter:
    blur(16px);
}

.overview-intro {
  min-width: 190px;
}

.overview-kicker {
  color:
    #60a5fa;

  font-size: 8px;

  font-weight: 950;

  letter-spacing: .20em;
}

.overview-intro h1 {
  margin: 4px 0 2px;

  color: #f8fafc;

  font-size: 18px;

  letter-spacing: -.03em;
}

.overview-intro p {
  margin: 0;

  color:
    rgba(148,163,184,.62);

  font-size: 9px;
}

.overview-stats {
  display: grid;

  grid-template-columns:
    repeat(4, minmax(110px,1fr));

  gap: 8px;

  flex: 1;

  max-width: 700px;
}

.overview-stat {
  min-height: 58px;

  display: flex;

  align-items: center;

  gap: 10px;

  padding: 8px 11px;

  border:
    1px solid
    rgba(148,163,184,.08);

  border-radius: 13px;

  background:
    rgba(15,23,42,.42);
}

.overview-stat-icon {
  width: 33px;
  height: 33px;

  flex: 0 0 auto;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 10px;

  font-size: 13px;

  font-weight: 900;
}

.overview-stat-icon.blue {
  color: #60a5fa;
  background:
    rgba(37,99,235,.12);
}

.overview-stat-icon.purple {
  color: #a78bfa;
  background:
    rgba(124,58,237,.12);
}

.overview-stat-icon.green {
  color: #34d399;
  background:
    rgba(16,185,129,.10);
}

.overview-stat-icon.cyan {
  color: #22d3ee;
  background:
    rgba(8,145,178,.10);
}

.overview-stat span {
  display: block;

  color:
    rgba(148,163,184,.60);

  font-size: 8px;

  font-weight: 800;

  letter-spacing: .07em;
}

.overview-stat strong {
  display: block;

  margin-top: 2px;

  color: #f8fafc;

  font-size: 16px;

  font-weight: 950;
}

.overview-online strong {
  color:
    #34d399;

  font-size: 11px;

  letter-spacing: .08em;
}

/* =========================================================
   SECTION HEADINGS
   ========================================================= */

.section-heading {
  display: flex;

  align-items: flex-end;

  gap: 20px;

  margin:
    0 0 15px;
}

.section-kicker {
  color:
    rgba(96,165,250,.76);

  font-size: 8px;

  font-weight: 950;

  letter-spacing: .18em;
}

.section-heading h2 {
  margin: 4px 0 0;

  color: #f1f5f9;

  font-size: 22px;

  letter-spacing: -.035em;

  font-weight: 950;
}

.section-line {
  height: 1px;

  flex: 1;

  margin-bottom: 7px;

  background:
    linear-gradient(
      90deg,
      rgba(96,165,250,.15),
      transparent
    );
}

.studio-section-heading {
  margin-top: 45px;
}

/* =========================================================
   ACCOUNT CARD
   ========================================================= */

.account-card {
  position: relative;

  overflow: hidden;

  margin-bottom: 19px;

  border:
    1px solid
    rgba(148,163,184,.12);

  border-radius: 24px;

  background:
    linear-gradient(
      135deg,
      rgba(15,29,49,.92),
      rgba(7,17,31,.88)
    );

  box-shadow:
    0 25px 65px
      rgba(0,0,0,.25),
    inset 0 1px 0
      rgba(255,255,255,.035);

  backdrop-filter:
    blur(17px);

  transition:
    border-color .25s ease,
    transform .25s ease;
}

.account-card::before {
  content: "";

  position: absolute;

  left: 0;
  right: 0;
  top: 0;

  height: 1px;

  background:
    linear-gradient(
      90deg,
      transparent,
      rgba(96,165,250,.34),
      rgba(129,140,248,.24),
      transparent
    );
}

.account-card:hover {
  border-color:
    rgba(96,165,250,.18);

  transform:
    translateY(-2px);
}

.account-top {
  min-height: 108px;

  padding: 20px 22px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 20px;

  position: relative;

  background:
    linear-gradient(
      90deg,
      rgba(30,58,138,.055),
      transparent 52%
    );

  border-bottom:
    1px solid
    rgba(148,163,184,.075);
}

.account-identity {
  display: flex;

  align-items: center;

  gap: 13px;

  min-width: 0;
}

.account-avatar-wrap {
  position: relative;

  flex: 0 0 auto;
}

.account-avatar {
  width: 52px;
  height: 52px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 16px;

  color: #fff;

  font-size: 15px;

  font-weight: 950;

  background:
    linear-gradient(
      145deg,
      #1877f2,
      #4f46e5
    );

  box-shadow:
    0 15px 30px
      rgba(37,99,235,.25),
    inset 0 1px 0
      rgba(255,255,255,.18);
}

.account-online {
  position: absolute;

  width: 10px;
  height: 10px;

  right: -2px;
  bottom: -1px;

  border-radius: 50%;

  background:
    #34d399;

  border:
    2px solid
    #0a1728;

  box-shadow:
    0 0 12px
      rgba(52,211,153,.65);
}

.account-details {
  min-width: 0;
}

.account-label {
  color:
    rgba(96,165,250,.72);

  font-size: 7px;

  font-weight: 950;

  letter-spacing: .16em;

  margin-bottom: 3px;
}

.account-identity h2 {
  margin: 0;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

  color: #f8fafc;

  font-size: 16px;

  font-weight: 900;

  letter-spacing: -.02em;
}

.facebook-id {
  display: flex;

  align-items: center;

  gap: 7px;

  margin-top: 5px;

  color:
    rgba(148,163,184,.48);

  font-size: 8px;
}

.facebook-id span {
  color:
    rgba(148,163,184,.35);

  font-size: 7px;

  font-weight: 850;

  letter-spacing: .08em;
}

.facebook-id code {
  color:
    rgba(191,219,254,.52);

  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
}

.account-right {
  display: flex;

  align-items: center;

  gap: 14px;
}

.account-status {
  display: inline-flex;

  align-items: center;

  gap: 6px;

  padding: 7px 9px;

  border-radius: 999px;

  color:
    rgba(52,211,153,.78);

  border:
    1px solid
    rgba(52,211,153,.10);

  background:
    rgba(16,185,129,.055);

  font-size: 7px;

  font-weight: 950;

  letter-spacing: .10em;
}

.account-status-dot {
  width: 5px;
  height: 5px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 8px
      rgba(52,211,153,.7);
}

.account-pages-count {
  min-width: 51px;

  text-align: center;
}

.account-pages-count strong {
  display: block;

  color:
    #e0f2fe;

  font-size: 19px;

  font-weight: 950;

  line-height: 1;
}

.account-pages-count span {
  display: block;

  margin-top: 4px;

  color:
    rgba(148,163,184,.42);

  font-size: 6px;

  font-weight: 900;

  letter-spacing: .13em;
}

.account-actions {
  display: flex;

  align-items: center;

  gap: 6px;
}

.account-actions form {
  margin: 0;
}

.btn {
  min-height: 36px;

  padding: 0 10px;

  display: inline-flex;

  align-items: center;

  justify-content: center;

  gap: 6px;

  border-radius: 10px;

  font-size: 9px;

  font-weight: 850;

  transition:
    transform .18s ease,
    box-shadow .18s ease,
    background .18s ease;
}

.btn:hover {
  transform:
    translateY(-2px);
}

.btn-blue {
  color:
    #bfdbfe;

  background:
    rgba(37,99,235,.11);

  border:
    1px solid
    rgba(96,165,250,.13);
}

.btn-blue:hover {
  color: #fff;

  background:
    rgba(37,99,235,.20);

  box-shadow:
    0 10px 25px
      rgba(37,99,235,.13);
}

.btn-red {
  color:
    #fca5a5;

  background:
    rgba(220,38,38,.055);

  border:
    1px solid
    rgba(248,113,113,.10);
}

.btn-red:hover {
  color: #fff;

  background:
    rgba(220,38,38,.13);

  box-shadow:
    0 10px 25px
      rgba(220,38,38,.10);
}

.btn-icon {
  font-size: 13px;
}

/* =========================================================
   PAGES
   ========================================================= */

.pages-area {
  padding: 17px 20px 20px;
}

.page-toolbar {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  margin-bottom: 11px;
}

.toolbar-title-wrap {
  display: flex;

  align-items: center;

  gap: 9px;
}

.toolbar-live-dot {
  width: 7px;
  height: 7px;

  border-radius: 50%;

  background:
    #22c55e;

  box-shadow:
    0 0 0 4px
    rgba(34,197,94,.07),
    0 0 13px
    rgba(34,197,94,.45);
}

.toolbar-title {
  color:
    rgba(191,219,254,.68);

  font-size: 8px;

  font-weight: 950;

  letter-spacing: .13em;
}

.toolbar-subtitle {
  margin-top: 3px;

  color:
    rgba(148,163,184,.40);

  font-size: 8px;
}

.toolbar-actions {
  display: flex;

  align-items: center;

  gap: 6px;
}

.toolbar-btn {
  min-height: 31px;

  padding: 0 10px;

  border-radius: 9px;

  color:
    rgba(148,163,184,.66);

  border:
    1px solid
    rgba(148,163,184,.08);

  background:
    rgba(15,23,42,.60);

  font-size: 8px;

  font-weight: 850;

  transition:
    .18s ease;
}

.toolbar-btn:hover {
  color: #fff;

  border-color:
    rgba(96,165,250,.16);

  background:
    rgba(30,41,59,.82);
}

.toolbar-select {
  color:
    rgba(147,197,253,.80);
}

.pages-list {
  display: grid;

  grid-template-columns:
    repeat(
      auto-fit,
      minmax(
        300px,
        1fr
      )
    );

  gap: 7px;
}

.page-row {
  min-height: 60px;

  position: relative;

  display: flex;

  align-items: center;

  gap: 10px;

  padding: 9px 10px;

  border:
    1px solid
    rgba(148,163,184,.065);

  border-radius: 14px;

  background:
    linear-gradient(
      135deg,
      rgba(15,30,50,.68),
      rgba(9,20,35,.54)
    );

  cursor: pointer;

  overflow: hidden;

  transition:
    transform .18s ease,
    border-color .18s ease,
    background .18s ease,
    box-shadow .18s ease;
}

.page-row::before {
  content: "";

  position: absolute;

  inset: 0;

  pointer-events: none;

  background:
    linear-gradient(
      100deg,
      transparent,
      rgba(96,165,250,.04),
      transparent
    );

  transform:
    translateX(-100%);

  transition:
    transform .45s ease;
}

.page-row:hover {
  transform:
    translateY(-2px);

  border-color:
    rgba(96,165,250,.16);

  background:
    linear-gradient(
      135deg,
      rgba(18,38,65,.82),
      rgba(10,24,41,.70)
    );

  box-shadow:
    0 12px 30px
      rgba(0,0,0,.18);
}

.page-row:hover::before {
  transform:
    translateX(100%);
}

.custom-check {
  width: 21px;
  height: 21px;

  position: relative;

  flex: 0 0 auto;
}

.custom-check input {
  position: absolute;

  opacity: 0;

  pointer-events: none;
}

.checkmark {
  position: absolute;

  inset: 0;

  display: flex;

  align-items: center;

  justify-content: center;

  border:
    1px solid
    rgba(148,163,184,.18);

  border-radius: 7px;

  background:
    rgba(2,6,23,.55);

  color: transparent;

  transition:
    .18s ease;
}

.checkmark span {
  font-size: 10px;

  font-weight: 950;
}

.custom-check input:checked
~ .checkmark {
  color: #fff;

  border-color:
    #3b82f6;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #4f46e5
    );

  box-shadow:
    0 5px 15px
      rgba(37,99,235,.22);
}

.page-row:has(
  .page-checkbox:checked
) {
  border-color:
    rgba(59,130,246,.28);

  background:
    linear-gradient(
      135deg,
      rgba(20,48,88,.78),
      rgba(15,29,55,.65)
    );

  box-shadow:
    inset 3px 0 0
      rgba(59,130,246,.80);
}

.page-avatar {
  width: 36px;
  height: 36px;

  flex: 0 0 auto;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 11px;

  color:
    #bfdbfe;

  background:
    linear-gradient(
      145deg,
      rgba(37,99,235,.18),
      rgba(79,70,229,.13)
    );

  border:
    1px solid
    rgba(96,165,250,.10);

  font-size: 9px;

  font-weight: 950;
}

.page-info {
  min-width: 0;

  flex: 1;
}

.page-info strong {
  display: block;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

  color:
    rgba(241,245,249,.90);

  font-size: 10px;

  font-weight: 850;
}

.page-info small {
  display: block;

  margin-top: 4px;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

  color:
    rgba(148,163,184,.42);

  font-size: 7px;
}

.page-ready {
  display: inline-flex;

  align-items: center;

  gap: 5px;

  padding: 5px 7px;

  border-radius: 999px;

  color:
    rgba(52,211,153,.68);

  background:
    rgba(16,185,129,.045);

  border:
    1px solid
    rgba(52,211,153,.07);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .10em;
}

.ready-dot {
  width: 4px;
  height: 4px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 7px
      rgba(52,211,153,.65);
}

.page-arrow {
  color:
    rgba(148,163,184,.20);

  font-size: 17px;

  transition:
    color .18s ease,
    transform .18s ease;
}

.page-row:hover .page-arrow {
  color:
    rgba(147,197,253,.65);

  transform:
    translateX(2px);
}

.empty-pages {
  min-height: 86px;

  display: flex;

  align-items: center;

  justify-content: center;

  gap: 11px;

  border-radius: 14px;

  border:
    1px dashed
    rgba(148,163,184,.10);

  background:
    rgba(15,23,42,.32);
}

.empty-pages-icon {
  width: 36px;
  height: 36px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 11px;

  color:
    rgba(96,165,250,.65);

  background:
    rgba(37,99,235,.08);

  font-size: 17px;
}

.empty-pages strong {
  display: block;

  color:
    rgba(226,232,240,.72);

  font-size: 10px;
}

.empty-pages span {
  display: block;

  margin-top: 3px;

  color:
    rgba(148,163,184,.40);

  font-size: 8px;
}

/* =========================================================
   STUDIO
   ========================================================= */

.studio-card {
  position: relative;

  overflow: hidden;

  padding: 25px;

  border:
    1px solid
    rgba(96,165,250,.14);

  border-radius: 27px;

  background:
    radial-gradient(
      circle at 100% 0%,
      rgba(79,70,229,.10),
      transparent 29%
    ),
    radial-gradient(
      circle at 0% 100%,
      rgba(8,145,178,.075),
      transparent 28%
    ),
    linear-gradient(
      135deg,
      rgba(12,28,49,.95),
      rgba(7,17,31,.94)
    );

  box-shadow:
    0 35px 85px
      rgba(0,0,0,.30),
    inset 0 1px 0
      rgba(255,255,255,.045);
}

.studio-card::before {
  content: "";

  position: absolute;

  left: 8%;
  right: 8%;
  top: 0;

  height: 1px;

  background:
    linear-gradient(
      90deg,
      transparent,
      rgba(96,165,250,.45),
      rgba(129,140,248,.30),
      transparent
    );
}

.studio-glow {
  position: absolute;

  border-radius: 50%;

  pointer-events: none;

  filter: blur(60px);

  opacity: .20;
}

.studio-glow-one {
  width: 260px;
  height: 260px;

  right: -130px;
  top: -120px;

  background:
    #2563eb;
}

.studio-glow-two {
  width: 220px;
  height: 220px;

  left: -130px;
  bottom: -130px;

  background:
    #7c3aed;
}

.studio-heading {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 20px;

  position: relative;

  z-index: 2;
}

.studio-title-wrap {
  display: flex;

  align-items: center;

  gap: 13px;
}

.studio-icon-wrap {
  position: relative;
}

.studio-icon {
  width: 48px;
  height: 48px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 15px;

  color: #bfdbfe;

  background:
    linear-gradient(
      145deg,
      rgba(37,99,235,.22),
      rgba(79,70,229,.18)
    );

  border:
    1px solid
    rgba(96,165,250,.16);

  box-shadow:
    0 12px 30px
      rgba(37,99,235,.12);

  font-size: 20px;
}

.studio-icon-wrap > span {
  position: absolute;

  width: 6px;
  height: 6px;

  right: -2px;
  top: -2px;

  border-radius: 50%;

  background:
    #22d3ee;

  box-shadow:
    0 0 12px
      rgba(34,211,238,.8);
}

.studio-kicker {
  color:
    #60a5fa;

  font-size: 8px;

  font-weight: 950;

  letter-spacing: .19em;

  margin-bottom: 5px;
}

.studio-heading h2 {
  margin: 0;

  color: #f8fafc;

  font-size: 22px;

  font-weight: 950;

  letter-spacing: -.035em;
}

.studio-heading p {
  margin: 5px 0 0;

  color:
    rgba(148,163,184,.55);

  font-size: 9px;
}

.selected-pill {
  min-height: 36px;

  display: inline-flex;

  align-items: center;

  gap: 7px;

  padding: 0 11px;

  border-radius: 999px;

  color:
    rgba(52,211,153,.78);

  border:
    1px solid
    rgba(52,211,153,.10);

  background:
    rgba(16,185,129,.055);

  font-size: 8px;

  font-weight: 900;

  white-space: nowrap;
}

.selected-dot {
  width: 6px;
  height: 6px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 10px
      rgba(52,211,153,.65);

  animation:
    pulse
    2s
    ease-in-out
    infinite;
}

.studio-divider {
  height: 1px;

  margin:
    22px 0;

  background:
    linear-gradient(
      90deg,
      rgba(148,163,184,.09),
      transparent
    );
}

/* =========================================================
   FORM FIELDS
   ========================================================= */

.field {
  margin-bottom: 18px;

  position: relative;

  z-index: 2;
}

.field-heading {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 10px;

  margin-bottom: 8px;
}

.field-heading label {
  color:
    rgba(226,232,240,.78);

  font-size: 10px;

  font-weight: 900;
}

.field-badge {
  padding: 4px 6px;

  border-radius: 5px;

  color:
    rgba(96,165,250,.62);

  background:
    rgba(37,99,235,.07);

  border:
    1px solid
    rgba(96,165,250,.07);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .11em;
}

.field-badge-soft {
  color:
    rgba(148,163,184,.42);

  background:
    rgba(148,163,184,.035);

  border-color:
    rgba(148,163,184,.06);
}

.textarea-shell {
  position: relative;
}

.textarea-decoration {
  position: absolute;

  left: 13px;
  top: 13px;

  width: 28px;
  height: 28px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 8px;

  color:
    rgba(147,197,253,.46);

  background:
    rgba(37,99,235,.07);

  font-size: 9px;

  font-weight: 950;

  pointer-events: none;

  z-index: 2;
}

textarea {
  width: 100%;

  min-height: 155px;

  resize: vertical;

  padding:
    17px
    15px
    15px
    53px;

  border:
    1px solid
    rgba(148,163,184,.10);

  border-radius: 16px;

  outline: none;

  background:
    rgba(2,8,20,.52);

  color:
    #e2e8f0;

  caret-color:
    #60a5fa;

  font-size: 12px;

  line-height: 1.65;

  transition:
    border-color .2s ease,
    box-shadow .2s ease,
    background .2s ease;
}

textarea::placeholder {
  color:
    rgba(148,163,184,.28);
}

textarea:focus {
  border-color:
    rgba(96,165,250,.28);

  background:
    rgba(2,8,20,.72);

  box-shadow:
    0 0 0 4px
      rgba(37,99,235,.055),
    0 18px 40px
      rgba(0,0,0,.12);
}

.field-meta {
  margin-top: 6px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 10px;

  color:
    rgba(148,163,184,.36);

  font-size: 7px;
}

#char-count {
  color:
    rgba(147,197,253,.50);

  font-weight: 850;
}

.upload-box {
  min-height: 137px;

  position: relative;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  gap: 4px;

  padding: 20px;

  overflow: hidden;

  border:
    1px dashed
    rgba(96,165,250,.16);

  border-radius: 17px;

  background:
    radial-gradient(
      circle at center,
      rgba(37,99,235,.055),
      transparent 50%
    ),
    rgba(2,8,20,.40);

  text-align: center;

  cursor: pointer;

  transition:
    border-color .2s ease,
    background .2s ease,
    transform .2s ease;
}

.upload-box::before {
  content: "";

  position: absolute;

  width: 45%;
  height: 1px;

  top: 0;
  left: 27.5%;

  background:
    linear-gradient(
      90deg,
      transparent,
      rgba(96,165,250,.35),
      transparent
    );
}

.upload-box:hover,
.upload-box.dragging {
  border-color:
    rgba(96,165,250,.35);

  background:
    radial-gradient(
      circle at center,
      rgba(37,99,235,.10),
      transparent 55%
    ),
    rgba(2,8,20,.60);

  transform:
    translateY(-2px);
}

.upload-box.has-file {
  border-style:
    solid;

  border-color:
    rgba(52,211,153,.22);

  background:
    rgba(6,78,59,.08);
}

.upload-pulse {
  position: absolute;

  width: 90px;
  height: 90px;

  border-radius: 50%;

  background:
    rgba(37,99,235,.07);

  filter: blur(10px);

  animation:
    pulse
    3s
    ease-in-out
    infinite;

  pointer-events: none;
}

.upload-icon {
  width: 38px;
  height: 38px;

  position: relative;

  z-index: 2;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 12px;

  color:
    #93c5fd;

  background:
    linear-gradient(
      145deg,
      rgba(37,99,235,.16),
      rgba(79,70,229,.13)
    );

  border:
    1px solid
    rgba(96,165,250,.12);

  font-size: 19px;

  font-weight: 900;
}

.upload-box strong {
  position: relative;

  z-index: 2;

  max-width: 88%;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

  color:
    rgba(226,232,240,.76);

  font-size: 10px;

  font-weight: 900;
}

.upload-box > span {
  position: relative;

  z-index: 2;

  color:
    rgba(148,163,184,.38);

  font-size: 7px;
}

.upload-box small {
  position: relative;

  z-index: 2;

  margin-top: 2px;

  color:
    rgba(96,165,250,.48);

  font-size: 7px;

  font-weight: 800;
}

.upload-box input {
  position: absolute;

  inset: 0;

  opacity: 0;

  cursor: pointer;
}

/* =========================================================
   BATCH NOTICE
   ========================================================= */

.batch-notice {
  display: flex;

  align-items: center;

  gap: 12px;

  position: relative;

  z-index: 2;

  padding: 13px 14px;

  margin:
    2px 0 20px;

  border:
    1px solid
    rgba(96,165,250,.09);

  border-radius: 15px;

  background:
    linear-gradient(
      100deg,
      rgba(37,99,235,.075),
      rgba(79,70,229,.045)
    );
}

.batch-icon {
  width: 34px;
  height: 34px;

  flex: 0 0 auto;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 10px;

  color:
    #fbbf24;

  background:
    rgba(245,158,11,.07);

  border:
    1px solid
    rgba(245,158,11,.08);

  font-size: 14px;
}

.batch-content {
  flex: 1;

  min-width: 0;
}

.batch-title-line {
  display: flex;

  align-items: center;

  gap: 8px;
}

.batch-title-line strong {
  color:
    rgba(191,219,254,.76);

  font-size: 9px;

  font-weight: 900;
}

.batch-title-line span {
  padding: 3px 5px;

  border-radius: 4px;

  color:
    rgba(96,165,250,.55);

  background:
    rgba(37,99,235,.07);

  font-size: 5px;

  font-weight: 950;

  letter-spacing: .08em;
}

.batch-content p {
  margin: 4px 0 0;

  color:
    rgba(148,163,184,.42);

  font-size: 7px;

  line-height: 1.5;
}

.batch-engine-status {
  display: inline-flex;

  align-items: center;

  gap: 5px;

  padding: 6px 7px;

  border-radius: 999px;

  color:
    rgba(52,211,153,.60);

  background:
    rgba(16,185,129,.045);

  border:
    1px solid
    rgba(52,211,153,.07);

  font-size: 5px;

  font-weight: 950;

  letter-spacing: .08em;
}

.batch-engine-status span {
  width: 4px;
  height: 4px;

  border-radius: 50%;

  background:
    #34d399;
}

/* =========================================================
   PUBLISH FOOTER
   ========================================================= */

.publish-footer {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  position: relative;

  z-index: 2;
}

.publish-footer-left {
  display: flex;

  align-items: center;

  gap: 9px;
}

.publish-shield {
  width: 30px;
  height: 30px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 9px;

  color:
    #34d399;

  background:
    rgba(16,185,129,.065);

  border:
    1px solid
    rgba(52,211,153,.08);

  font-size: 10px;

  font-weight: 950;
}

.publish-footer-left strong {
  display: block;

  color:
    rgba(226,232,240,.65);

  font-size: 8px;

  font-weight: 850;
}

.publish-footer-left span {
  display: block;

  margin-top: 3px;

  color:
    rgba(148,163,184,.34);

  font-size: 7px;
}

.publish-btn {
  min-height: 49px;

  padding: 0 10px 0 13px;

  display: inline-flex;

  align-items: center;

  gap: 9px;

  border-radius: 13px;

  color: #fff;

  background:
    linear-gradient(
      135deg,
      #155eef,
      #4f46e5
    );

  box-shadow:
    0 15px 35px
      rgba(37,99,235,.19);

  font-size: 9px;

  font-weight: 950;

  position: relative;

  overflow: hidden;

  transition:
    transform .2s ease,
    box-shadow .2s ease,
    opacity .2s ease;
}

.publish-btn::before {
  content: "";

  position: absolute;

  inset: 0;

  background:
    linear-gradient(
      90deg,
      transparent,
      rgba(255,255,255,.16),
      transparent
    );

  transform:
    translateX(-130%);
}

.publish-btn:hover::before {
  animation:
    shine
    .8s
    ease;
}

.publish-btn:hover {
  transform:
    translateY(-3px);

  box-shadow:
    0 21px 45px
      rgba(37,99,235,.28);
}

.publish-btn.has-selection {
  box-shadow:
    0 15px 40px
      rgba(37,99,235,.26);
}

.publish-btn:disabled {
  opacity: .65;

  cursor: wait;

  transform: none;
}

.publish-btn-icon {
  width: 29px;
  height: 29px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 8px;

  background:
    rgba(255,255,255,.12);

  font-size: 10px;
}

.publish-btn-arrow {
  width: 27px;
  height: 27px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 8px;

  background:
    rgba(255,255,255,.10);

  font-size: 13px;
}

/* =========================================================
   EMPTY STATE
   ========================================================= */

.empty-state {
  min-height: 390px;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  padding: 45px 25px;

  position: relative;

  overflow: hidden;

  text-align: center;

  border:
    1px solid
    rgba(96,165,250,.12);

  border-radius: 25px;

  background:
    radial-gradient(
      circle at center,
      rgba(37,99,235,.08),
      transparent 40%
    ),
    rgba(8,20,35,.72);

  box-shadow:
    0 30px 70px
      rgba(0,0,0,.24);
}

.empty-state::before {
  content: "";

  position: absolute;

  width: 500px;
  height: 500px;

  border-radius: 50%;

  border:
    1px solid
    rgba(96,165,250,.05);

  box-shadow:
    0 0 0 80px
      rgba(96,165,250,.012),
    0 0 0 160px
      rgba(96,165,250,.008);
}

.empty-visual {
  width: 82px;
  height: 82px;

  position: relative;

  display: flex;

  align-items: center;
  justify-content: center;

  margin-bottom: 18px;
}

.empty-visual-ring {
  position: absolute;

  inset: 0;

  border:
    1px solid
    rgba(96,165,250,.22);

  border-radius: 50%;

  animation:
    rotate
    8s
    linear
    infinite;
}

.empty-visual-ring::before {
  content: "";

  position: absolute;

  width: 7px;
  height: 7px;

  top: -3px;
  left: 50%;

  border-radius: 50%;

  background:
    #60a5fa;

  box-shadow:
    0 0 15px
      rgba(96,165,250,.8);
}

.empty-visual-icon {
  width: 52px;
  height: 52px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 16px;

  color: #fff;

  background:
    linear-gradient(
      145deg,
      #1877f2,
      #4f46e5
    );

  box-shadow:
    0 18px 35px
      rgba(37,99,235,.25);

  font-size: 24px;

  font-weight: 950;
}

.empty-kicker {
  color:
    rgba(96,165,250,.65);

  font-size: 7px;

  font-weight: 950;

  letter-spacing: .20em;

  position: relative;
}

.empty-state h2 {
  margin: 7px 0 6px;

  color:
    #f8fafc;

  font-size: 22px;

  font-weight: 950;

  letter-spacing: -.035em;

  position: relative;
}

.empty-state p {
  max-width: 470px;

  margin: 0 0 20px;

  color:
    rgba(148,163,184,.48);

  font-size: 10px;

  line-height: 1.6;

  position: relative;
}

.empty-connect {
  position: relative;
}

/* =========================================================
   FOOTER
   ========================================================= */

.dashboard-footer {
  width:
    min(
      1160px,
      calc(100% - 32px)
    );

  margin:
    36px auto 0;

  padding:
    17px 3px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  color:
    rgba(148,163,184,.28);

  border-top:
    1px solid
    rgba(148,163,184,.06);

  font-size: 7px;

  font-weight: 800;

  letter-spacing: .06em;
}

.dashboard-footer strong {
  color:
    rgba(147,197,253,.45);

  font-weight: 950;
}

.footer-status {
  display: flex;

  align-items: center;

  gap: 6px;
}

.footer-status span {
  width: 5px;
  height: 5px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 9px
      rgba(52,211,153,.7);
}

/* =========================================================
   RESULTS PAGE
   ========================================================= */

.results-page {
  min-height: 100vh;

  position: relative;

  padding:
    18px 0 60px;
}

.results-background-orb {
  position: fixed;

  border-radius: 50%;

  pointer-events: none;

  filter: blur(80px);

  opacity: .22;
}

.result-orb-one {
  width: 420px;
  height: 420px;

  left: -220px;
  top: 160px;

  background:
    #2563eb;
}

.result-orb-two {
  width: 390px;
  height: 390px;

  right: -210px;
  bottom: 100px;

  background:
    #7c3aed;
}

.results-container {
  width:
    min(
      1100px,
      calc(100% - 32px)
    );

  margin: 0 auto;
}

.results-topbar {
  min-height: 68px;

  padding: 9px 10px 9px 13px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  border:
    1px solid
    rgba(148,163,184,.11);

  border-radius: 18px;

  background:
    rgba(9,20,35,.76);

  box-shadow:
    0 18px 50px
      rgba(0,0,0,.22);

  backdrop-filter:
    blur(16px);
}

.results-brand {
  display: flex;

  align-items: center;

  gap: 10px;
}

.results-logo {
  width: 42px;
  height: 42px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 12px;

  color: #fff;

  background:
    linear-gradient(
      145deg,
      #1877f2,
      #4f46e5
    );

  font-size: 20px;

  font-weight: 950;
}

.results-brand-mini {
  color:
    rgba(96,165,250,.70);

  font-size: 7px;

  font-weight: 950;

  letter-spacing: .18em;
}

.results-brand-name {
  margin-top: 3px;

  color:
    rgba(226,232,240,.60);

  font-size: 8px;

  font-weight: 850;

  letter-spacing: .05em;
}

.results-back {
  min-height: 39px;

  display: inline-flex;

  align-items: center;

  gap: 7px;

  padding: 0 12px;

  border-radius: 10px;

  color:
    rgba(191,219,254,.72);

  border:
    1px solid
    rgba(96,165,250,.10);

  background:
    rgba(37,99,235,.06);

  font-size: 9px;

  font-weight: 850;
}

.results-back:hover {
  color: #fff;

  background:
    rgba(37,99,235,.13);
}

.results-hero {
  min-height: 230px;

  display: flex;

  align-items: center;

  gap: 25px;

  padding:
    35px 10px 20px;
}

.results-success-ring {
  width: 78px;
  height: 78px;

  flex: 0 0 auto;

  padding: 1px;

  border-radius: 50%;

  background:
    conic-gradient(
      #34d399,
      #22d3ee,
      #2563eb,
      #34d399
    );

  box-shadow:
    0 0 40px
      rgba(52,211,153,.12);
}

.results-success-ring > div {
  width: 100%;
  height: 100%;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 50%;

  background:
    #061322;

  color:
    #34d399;

  font-size: 28px;

  font-weight: 950;
}

.results-kicker {
  color:
    rgba(52,211,153,.68);

  font-size: 8px;

  font-weight: 950;

  letter-spacing: .20em;
}

.results-hero h1 {
  margin: 5px 0 6px;

  color: #f8fafc;

  font-size: 42px;

  line-height: 1;

  letter-spacing: -.055em;

  font-weight: 950;
}

.results-hero p {
  margin: 0;

  color:
    rgba(148,163,184,.50);

  font-size: 10px;
}

.results-stats {
  display: grid;

  grid-template-columns:
    repeat(3,1fr);

  gap: 10px;

  margin-bottom: 17px;
}

.result-stat {
  min-height: 90px;

  display: flex;

  align-items: center;

  gap: 11px;

  padding: 15px;

  border:
    1px solid
    rgba(148,163,184,.09);

  border-radius: 16px;

  background:
    rgba(9,20,35,.72);

  box-shadow:
    0 15px 40px
      rgba(0,0,0,.15);
}

.result-stat-icon {
  width: 38px;
  height: 38px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 11px;

  font-size: 14px;

  font-weight: 950;
}

.result-stat-total .result-stat-icon {
  color: #60a5fa;
  background:
    rgba(37,99,235,.09);
}

.result-stat-success .result-stat-icon {
  color: #34d399;
  background:
    rgba(16,185,129,.08);
}

.result-stat-failed .result-stat-icon {
  color: #f87171;
  background:
    rgba(220,38,38,.07);
}

.result-stat span {
  display: block;

  color:
    rgba(148,163,184,.40);

  font-size: 7px;

  font-weight: 850;

  letter-spacing: .08em;
}

.result-stat strong {
  display: block;

  margin-top: 4px;

  color:
    #f1f5f9;

  font-size: 22px;

  font-weight: 950;
}

.results-card {
  overflow: hidden;

  padding: 19px;

  border:
    1px solid
    rgba(148,163,184,.10);

  border-radius: 21px;

  background:
    rgba(9,20,35,.78);

  box-shadow:
    0 25px 65px
      rgba(0,0,0,.22);
}

.results-card-header {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  padding-bottom: 13px;

  border-bottom:
    1px solid
    rgba(148,163,184,.07);
}

.results-card-kicker {
  color:
    rgba(96,165,250,.50);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .18em;
}

.results-card-header h2 {
  margin: 4px 0 0;

  color:
    rgba(241,245,249,.82);

  font-size: 15px;

  font-weight: 900;
}

.results-live {
  display: inline-flex;

  align-items: center;

  gap: 5px;

  padding: 6px 8px;

  border-radius: 999px;

  color:
    rgba(52,211,153,.60);

  background:
    rgba(16,185,129,.045);

  border:
    1px solid
    rgba(52,211,153,.07);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .08em;
}

.results-live span {
  width: 4px;
  height: 4px;

  border-radius: 50%;

  background:
    #34d399;
}

.results-list {
  display: grid;
}

.result-row {
  display: grid;

  grid-template-columns:
    1fr auto;

  gap: 12px;

  padding: 12px 4px;

  border-bottom:
    1px solid
    rgba(148,163,184,.055);
}

.result-row:last-child {
  border-bottom: 0;
}

.result-page-main {
  display: flex;

  align-items: center;

  gap: 9px;
}

.result-page-avatar {
  width: 33px;
  height: 33px;

  flex: 0 0 auto;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 10px;

  color:
    #bfdbfe;

  background:
    rgba(37,99,235,.10);

  border:
    1px solid
    rgba(96,165,250,.09);

  font-size: 8px;

  font-weight: 950;
}

.result-row strong {
  color:
    rgba(226,232,240,.76);

  font-size: 9px;

  font-weight: 850;
}

.result-id {
  margin-top: 3px;

  color:
    rgba(148,163,184,.33);

  font-size: 6px;
}

.result-post-id {
  margin-top: 3px;

  color:
    rgba(52,211,153,.43);

  font-size: 6px;
}

.result-status {
  align-self: center;

  display: inline-flex;

  align-items: center;

  gap: 5px;

  padding: 6px 8px;

  border-radius: 999px;

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .06em;
}

.result-status.success {
  color:
    rgba(52,211,153,.72);

  background:
    rgba(16,185,129,.055);

  border:
    1px solid
    rgba(52,211,153,.08);
}

.result-status.failed {
  color:
    rgba(248,113,113,.72);

  background:
    rgba(220,38,38,.05);

  border:
    1px solid
    rgba(248,113,113,.08);
}

.status-icon {
  width: 14px;
  height: 14px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 50%;

  background:
    rgba(255,255,255,.04);

  font-size: 7px;
}

.result-error {
  grid-column:
    1 / -1;

  padding: 8px 9px;

  border-radius: 8px;

  color:
    rgba(248,113,113,.60);

  background:
    rgba(220,38,38,.035);

  font-size: 7px;

  line-height: 1.5;
}

/* =========================================================
   LOGIN
   ========================================================= */

.login-page {
  min-height: 100vh;

  display: flex;

  align-items: center;
  justify-content: center;

  padding: 22px;

  position: relative;

  overflow: hidden;

  background:
    radial-gradient(
      circle at 15% 10%,
      rgba(37,99,235,.17),
      transparent 30%
    ),
    radial-gradient(
      circle at 88% 90%,
      rgba(124,58,237,.15),
      transparent 30%
    ),
    linear-gradient(
      135deg,
      #020617,
      #061222 50%,
      #030712
    );
}

.login-page::before {
  content: "";

  position: absolute;

  inset: 0;

  pointer-events: none;

  background-image:
    linear-gradient(
      rgba(96,165,250,.03) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(96,165,250,.03) 1px,
      transparent 1px
    );

  background-size: 42px 42px;
}

.login-grid {
  position: absolute;

  inset: 0;

  pointer-events: none;

  background:
    radial-gradient(
      ellipse at center,
      transparent 10%,
      rgba(2,6,23,.35) 70%
    );
}

.login-background-orb {
  position: absolute;

  border-radius: 50%;

  filter: blur(80px);

  pointer-events: none;
}

.orb-one {
  width: 330px;
  height: 330px;

  left: -160px;
  top: -100px;

  background:
    rgba(37,99,235,.18);
}

.orb-two {
  width: 350px;
  height: 350px;

  right: -170px;
  bottom: -130px;

  background:
    rgba(124,58,237,.17);
}

.orb-three {
  width: 180px;
  height: 180px;

  right: 18%;
  top: 15%;

  background:
    rgba(8,145,178,.08);
}

.login-card {
  width:
    min(
      445px,
      100%
    );

  padding:
    27px 30px 22px;

  position: relative;

  z-index: 2;

  border:
    1px solid
    rgba(148,163,184,.13);

  border-radius: 27px;

  background:
    linear-gradient(
      145deg,
      rgba(12,28,48,.93),
      rgba(5,14,27,.96)
    );

  box-shadow:
    0 40px 100px
      rgba(0,0,0,.50),
    inset 0 1px 0
      rgba(255,255,255,.04);

  backdrop-filter:
    blur(20px);

  animation:
    riseIn
    .5s
    ease
    both;
}

.login-card::before {
  content: "";

  position: absolute;

  left: 12%;
  right: 12%;
  top: 0;

  height: 1px;

  background:
    linear-gradient(
      90deg,
      transparent,
      rgba(96,165,250,.45),
      rgba(129,140,248,.32),
      transparent
    );
}

.login-top-line {
  display: flex;

  align-items: center;
  justify-content: center;

  gap: 8px;

  margin-bottom: 22px;

  color:
    rgba(96,165,250,.55);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .20em;
}

.login-top-line span {
  width: 18px;
  height: 1px;

  background:
    rgba(96,165,250,.20);
}

.login-brand {
  display: flex;

  align-items: center;

  gap: 11px;

  margin-bottom: 29px;
}

.brand-mark {
  width: 46px;
  height: 46px;

  flex: 0 0 auto;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 14px;

  color: #fff;

  background:
    linear-gradient(
      145deg,
      #1877f2,
      #4f46e5
    );

  box-shadow:
    0 14px 30px
      rgba(37,99,235,.22);
}

.brand-mark span {
  transform:
    translateY(2px);

  font-size: 27px;

  font-weight: 950;
}

.brand-mini {
  color:
    rgba(148,163,184,.48);

  font-size: 6px;

  font-weight: 950;

  letter-spacing: .15em;
}

.brand-name {
  margin-top: 5px;

  color:
    rgba(191,219,254,.72);

  font-size: 12px;

  font-weight: 950;

  letter-spacing: .15em;
}

.login-icon {
  width: 38px;
  height: 38px;

  display: flex;

  align-items: center;
  justify-content: center;

  margin-bottom: 13px;

  border-radius: 11px;

  color:
    #60a5fa;

  background:
    rgba(37,99,235,.08);

  border:
    1px solid
    rgba(96,165,250,.10);

  font-size: 12px;
}

.login-kicker {
  color:
    rgba(96,165,250,.64);

  font-size: 7px;

  font-weight: 950;

  letter-spacing: .17em;
}

.login-card h1 {
  margin: 5px 0 7px;

  color: #f8fafc;

  font-size: 31px;

  line-height: 1;

  font-weight: 950;

  letter-spacing: -.045em;
}

.login-description {
  margin: 0 0 22px;

  color:
    rgba(148,163,184,.48);

  font-size: 9px;

  line-height: 1.6;
}

.login-error {
  display: flex;

  align-items: center;

  gap: 8px;

  margin-bottom: 15px;

  padding: 10px;

  border-radius: 10px;

  color:
    rgba(248,113,113,.72);

  background:
    rgba(220,38,38,.055);

  border:
    1px solid
    rgba(248,113,113,.09);

  font-size: 8px;

  line-height: 1.4;
}

.login-error > span {
  width: 20px;
  height: 20px;

  flex: 0 0 auto;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 7px;

  color:
    #f87171;

  background:
    rgba(220,38,38,.08);

  font-weight: 950;
}

.login-card .field {
  margin-bottom: 14px;
}

.login-card .field label {
  display: block;

  margin-bottom: 7px;

  color:
    rgba(203,213,225,.58);

  font-size: 8px;

  font-weight: 850;
}

.password-shell {
  position: relative;
}

.password-shell input {
  width: 100%;

  height: 49px;

  padding:
    0 39px 0 39px;

  border:
    1px solid
    rgba(148,163,184,.11);

  border-radius: 13px;

  outline: none;

  color:
    #e2e8f0;

  background:
    rgba(2,8,20,.58);

  font-size: 10px;

  transition:
    border-color .2s ease,
    box-shadow .2s ease;
}

.password-shell input::placeholder {
  color:
    rgba(148,163,184,.27);
}

.password-shell input:focus {
  border-color:
    rgba(96,165,250,.28);

  box-shadow:
    0 0 0 4px
      rgba(37,99,235,.055);
}

.password-icon,
.password-lock {
  position: absolute;

  top: 50%;

  transform:
    translateY(-50%);

  z-index: 2;

  pointer-events: none;
}

.password-icon {
  left: 13px;

  color:
    rgba(96,165,250,.42);

  font-size: 8px;
}

.password-lock {
  right: 14px;

  color:
    rgba(148,163,184,.23);

  font-size: 7px;
}

.login-submit {
  width: 100%;

  min-height: 49px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding:
    0 9px 0 15px;

  border-radius: 13px;

  color: #fff;

  background:
    linear-gradient(
      135deg,
      #155eef,
      #4f46e5
    );

  box-shadow:
    0 15px 35px
      rgba(37,99,235,.20);

  font-size: 10px;

  font-weight: 950;

  transition:
    transform .2s ease,
    box-shadow .2s ease;
}

.login-submit strong {
  width: 31px;
  height: 31px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 9px;

  background:
    rgba(255,255,255,.11);

  font-size: 13px;
}

.login-submit:hover {
  transform:
    translateY(-2px);

  box-shadow:
    0 21px 43px
      rgba(37,99,235,.28);
}

.login-security {
  margin-top: 17px;

  padding-top: 14px;

  display: flex;

  align-items: center;
  justify-content: center;

  gap: 6px;

  border-top:
    1px solid
    rgba(148,163,184,.06);

  color:
    rgba(148,163,184,.29);

  font-size: 6px;

  font-weight: 850;

  letter-spacing: .06em;
}

.security-dot {
  width: 4px;
  height: 4px;

  border-radius: 50%;

  background:
    #34d399;

  box-shadow:
    0 0 8px
      rgba(52,211,153,.6);
}

.security-divider {
  width: 1px;
  height: 9px;

  background:
    rgba(148,163,184,.10);

  margin: 0 2px;
}

.login-footer-brand {
  position: absolute;

  left: 0;
  right: 0;

  bottom: 17px;

  text-align: center;

  color:
    rgba(148,163,184,.18);

  font-size: 6px;

  font-weight: 850;

  letter-spacing: .16em;
}

/* =========================================================
   RESPONSIVE
   ========================================================= */

@media (max-width: 980px) {

  .hero-header {
    min-height: auto;

    padding:
      25px 27px 30px;
  }

  .hero-main {
    align-items: flex-start;
  }

  .hero-visual {
    width: 220px;
    height: 220px;
  }

  .hero-core {
    width: 105px;
    height: 105px;
  }

  .orbit-one {
    width: 160px;
    height: 160px;
  }

  .orbit-two {
    width: 200px;
    height: 200px;
  }

  .overview-strip {
    align-items: flex-start;

    flex-direction: column;
  }

  .overview-stats {
    width: 100%;

    max-width: none;
  }
}

@media (max-width: 820px) {

  .hero-main {
    flex-direction: column;
  }

  .hero-visual {
    align-self: center;

    margin-top: 3px;
  }

  .header-actions {
    justify-content: flex-start;
  }

  .account-top {
    align-items: flex-start;

    flex-direction: column;
  }

  .account-right {
    width: 100%;

    justify-content: space-between;
  }

  .account-actions {
    margin-left: auto;
  }

  .overview-stats {
    grid-template-columns:
      repeat(2,1fr);
  }

  .pages-list {
    grid-template-columns: 1fr;
  }

  .results-stats {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {

  .hero-header {
    width:
      calc(100% - 18px);

    margin-top: 9px;

    border-radius: 25px;

    padding:
      21px 19px 23px;
  }

  .hero-top-line {
    font-size: 6px;

    letter-spacing: .13em;
  }

  .hero-title {
    font-size: 36px;
  }

  .hero-subtitle {
    font-size: 10px;
  }

  .hero-visual {
    width: 190px;
    height: 190px;
  }

  .hero-core {
    width: 88px;
    height: 88px;
  }

  .hero-core-inner strong {
    font-size: 20px;
  }

  .orbit-one {
    width: 135px;
    height: 135px;
  }

  .orbit-two {
    width: 175px;
    height: 175px;
  }

  .card-top {
    right: -4px;
    top: 14px;
  }

  .card-bottom {
    left: -8px;
    bottom: 18px;
  }

  .header-actions {
    display: grid;

    grid-template-columns:
      1fr auto;

    width: 100%;
  }

  .connect-btn {
    width: 100%;
  }

  .container {
    width:
      calc(100% - 18px);
  }

  .overview-strip {
    padding: 15px;

    border-radius: 17px;
  }

  .overview-stats {
    grid-template-columns:
      repeat(2,1fr);
  }

  .section-heading h2 {
    font-size: 18px;
  }

  .account-top {
    padding: 17px;
  }

  .account-right {
    align-items: flex-start;

    flex-wrap: wrap;
  }

  .account-pages-count {
    order: 2;
  }

  .account-status {
    order: 1;
  }

  .account-actions {
    width: 100%;

    order: 3;

    margin-left: 0;
  }

  .account-actions form {
    flex: 1;
  }

  .account-actions .btn {
    width: 100%;
  }

  .pages-area {
    padding:
      14px 14px 15px;
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
    padding:
      18px 15px;

    border-radius: 21px;
  }

  .studio-heading {
    align-items: flex-start;

    flex-direction: column;
  }

  .selected-pill {
    width: 100%;

    justify-content: center;
  }

  .batch-notice {
    align-items: flex-start;
  }

  .batch-engine-status {
    display: none;
  }

  .publish-footer {
    align-items: stretch;

    flex-direction: column;
  }

  .publish-btn {
    width: 100%;

    justify-content: space-between;
  }

  .dashboard-footer {
    width:
      calc(100% - 18px);

    align-items: flex-start;

    flex-direction: column;
  }

  .results-container {
    width:
      calc(100% - 18px);
  }

  .results-topbar {
    min-height: 60px;
  }

  .results-brand-name {
    font-size: 7px;
  }

  .results-hero {
    align-items: flex-start;

    flex-direction: column;

    padding:
      29px 5px 19px;
  }

  .results-hero h1 {
    font-size: 34px;
  }
}

@media (max-width: 520px) {

  .hero-title {
    font-size: 31px;
  }

  .hero-badges {
    gap: 5px;
  }

  .hero-badge {
    font-size: 6px;
  }

  .hero-visual {
    transform:
      scale(.90);
  }

  .header-actions {
    grid-template-columns: 1fr;
  }

  .header-actions form {
    width: 100%;
  }

  .header-logout {
    width: 100%;
  }

  .overview-stats {
    grid-template-columns:
      1fr 1fr;
  }

  .overview-stat {
    padding: 7px;

    gap: 7px;
  }

  .overview-stat-icon {
    width: 28px;
    height: 28px;

    font-size: 10px;
  }

  .overview-stat strong {
    font-size: 14px;
  }

  .overview-stat span {
    font-size: 6px;
  }

  .account-right {
    gap: 9px;
  }

  .account-status {
    display: none;
  }

  .account-pages-count {
    margin-right: auto;
  }

  .page-row {
    min-height: 57px;

    padding: 8px;
  }

  .page-avatar {
    width: 32px;
    height: 32px;
  }

  .page-info strong {
    font-size: 9px;
  }

  .studio-title-wrap {
    align-items: flex-start;
  }

  .studio-icon {
    width: 42px;
    height: 42px;
  }

  textarea {
    min-height: 135px;
  }

  .batch-content p {
    font-size: 6px;
  }

  .login-page {
    padding: 14px;
  }

  .login-card {
    padding:
      24px 20px 19px;

    border-radius: 23px;
  }

  .login-card h1 {
    font-size: 28px;
  }

  .login-footer-brand {
    display: none;
  }

  .results-hero h1 {
    font-size: 29px;
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
      '<meta name="theme-color" content="#030712">' +
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
// JSON
// =============================================================

function json(
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
          "no-store, no-cache, must-revalidate, max-age=0"
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


// =============================================================
// INITIALS
// =============================================================

function getInitials(
  name
) {
  const value =
    String(
      name ||
      ""
    ).trim();

  if (!value) {
    return "FB";
  }

  const parts =
    value
      .split(/\s+/)
      .filter(Boolean);

  if (
    parts.length === 1
  ) {
    return parts[0]
      .slice(0,2)
      .toUpperCase();
  }

  return (
    parts[0][0] +
    parts[
      parts.length - 1
    ][0]
  ).toUpperCase();
}
