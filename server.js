javascript
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
              Location:
                url.origin + "/login",
              "Set-Cookie":
                clearAuthCookie(),
              "Cache-Control":
                "no-store"
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
        const response =
          await syncPages(
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
        const response =
          await removeAccount(
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
    WHERE expires_at < ?
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
    Number(row.expires_at) <
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
        '</div>' +
        '<div class="' +
          (
            result.success
              ? "result-status success"
              : "result-status failed"
          ) +
        '">' +
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
    '<div class="results-container">' +

      '<div class="results-topbar">' +
        '<div>' +
          '<div class="brand-name">' +
            escapeHtml(
              APP_NAME
            ) +
          '</div>' +
          '<div class="subtitle">' +
            'Publishing Results' +
          '</div>' +
        '</div>' +

        '<a class="header-logout" href="/">' +
          'Back to Dashboard' +
        '</a>' +
      '</div>' +

      '<div class="results-hero">' +
        '<div class="hero-kicker">' +
          'PUBLISH COMPLETE' +
        '</div>' +
        '<h1>Publishing Results</h1>' +
        '<p>Your publishing run has been processed.</p>' +
      '</div>' +

      '<div class="results-stats">' +

        '<div class="result-stat">' +
          '<span>Total Pages</span>' +
          '<strong>' +
            results.length +
          '</strong>' +
        '</div>' +

        '<div class="result-stat">' +
          '<span>Published</span>' +
          '<strong>' +
            successCount +
          '</strong>' +
        '</div>' +

        '<div class="result-stat">' +
          '<span>Failed</span>' +
          '<strong>' +
            failedCount +
          '</strong>' +
        '</div>' +

      '</div>' +

      '<div class="results-card">' +
        '<div class="results-card-header">' +
          '<h2>Page Results</h2>' +
          '<span>' +
            escapeHtml(
              APP_NAME
            ) +
          '</span>' +
        '</div>' +
        rows +
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
        '<div class="empty-icon">+</div>' +
        '<h2>No Facebook Account Connected</h2>' +
        '<p>Connect a Facebook account to load and manage its Pages.</p>' +
        '<a class="connect-btn empty-connect" href="/auth/meta">' +
          '+ Connect Facebook Account' +
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
            'No Pages found. Click Sync Pages to refresh.' +
          '</div>';

      } else {

        pageHtml =
          '<div class="page-toolbar">' +
            '<div class="toolbar-title">' +
              'Connected Pages' +
            '</div>' +

            '<div class="toolbar-actions">' +
              '<button class="toolbar-btn" type="button" onclick="selectAccountPages(' +
                account.id +
                ',true)">' +
                'Select All' +
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
                '<span class="checkmark"></span>' +
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
                  'Facebook Page ID: ' +
                  escapeHtml(
                    page.facebook_page_id
                  ) +
                '</small>' +
              '</span>' +

              '<span class="page-ready">' +
                '<span class="ready-dot"></span>' +
                'READY' +
              '</span>' +

            '</label>';
        }

        pageHtml +=
          '</div>';
      }

      accountHtml +=
        '<section class="account-card">' +

          '<div class="account-top">' +

            '<div class="account-identity">' +

              '<div class="account-avatar">' +
                escapeHtml(
                  getInitials(
                    account.account_name ||
                    "Facebook Account"
                  )
                ) +
              '</div>' +

              '<div>' +
                '<h2>' +
                  escapeHtml(
                    account.account_name ||
                    "Facebook Account"
                  ) +
                '</h2>' +

                '<div class="facebook-id">' +
                  'Facebook ID: ' +
                  '<code>' +
                    escapeHtml(
                      account.facebook_user_id
                    ) +
                  '</code>' +
                '</div>' +

                '<div class="account-pages-count">' +
                  accountPages.length +
                  ' Connected Page' +
                  (
                    accountPages.length === 1
                      ? ""
                      : "s"
                  ) +
                '</div>' +

              '</div>' +

            '</div>' +

            '<div class="account-actions">' +

              '<form method="POST" action="/sync">' +
                '<input type="hidden" name="account_id" value="' +
                  escapeHtml(
                    account.id
                  ) +
                '" />' +
                '<button class="btn btn-blue" type="submit">' +
                  'Sync Pages' +
                '</button>' +
              '</form>' +

              '<form method="POST" action="/remove-account" onsubmit="return confirm(\\'Remove this Facebook account and all its connected Pages?\\');">' +
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

        '<div class="studio-heading">' +

          '<div class="studio-title-wrap">' +
            '<div class="studio-icon">✦</div>' +

            '<div>' +
              '<div class="studio-kicker">' +
                'PUBLISHING STUDIO' +
              '</div>' +

              '<h2>Create & Publish</h2>' +

              '<p>' +
                'Publish content to selected Facebook Pages.' +
              '</p>' +
            '</div>' +

          '</div>' +

          '<div class="selected-pill">' +
            '<span class="selected-dot"></span>' +
            '<span id="selected-count">0 Pages Selected</span>' +
          '</div>' +

        '</div>' +

        '<form id="publish-form" enctype="multipart/form-data">' +

          '<div class="field">' +
            '<label for="message">Post Text</label>' +
            '<textarea id="message" name="message" maxlength="63206" rows="7" placeholder="Write your post here..."></textarea>' +

            '<div class="field-meta">' +
              '<span>Maximum 63,206 characters</span>' +
              '<span id="char-count">0 / 63,206</span>' +
            '</div>' +
          '</div>' +

          '<div class="field">' +
            '<label for="media">Image / Video</label>' +

            '<div class="upload-box" id="upload-box">' +
              '<div class="upload-icon">↑</div>' +
              '<strong>Choose image or video</strong>' +
              '<span>Maximum file size: 100 MB</span>' +
              '<input id="media" type="file" name="media" accept="image/*,video/*" />' +
            '</div>' +

          '</div>' +

          '<div class="batch-notice">' +
            '<span>⚡</span>' +
            '<div>' +
              '<strong>Smart Batch Publishing</strong>' +
              '<p>Pages are automatically processed in batches of 15 to keep large publishing runs reliable.</p>' +
            '</div>' +
          '</div>' +

          '<div class="publish-footer">' +
            '<span class="publish-hint">' +
              'Select Pages above, add your content, then publish.' +
            '</span>' +

            '<button class="publish-btn" id="publish-btn" type="submit">' +
              '<span class="publish-btn-text">Publish to Selected Pages</span>' +
            '</button>' +
          '</div>' +

        '</form>' +

      '</section>';
  }

  return page(
    APP_NAME,
    '<div class="dashboard-shell">' +

      '<div class="dashboard-glow glow-a"></div>' +
      '<div class="dashboard-glow glow-b"></div>' +

      '<header class="hero-header">' +

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
            'Manage accounts, select Pages and publish content from one professional dashboard.' +
          '</div>' +
        '</div>' +

        '<div class="header-actions">' +

          '<a class="connect-btn" href="/auth/meta">' +
            '<span>+</span> Connect Facebook Account' +
          '</a>' +

          '<form method="POST" action="/logout">' +
            '<button class="header-logout" type="submit">' +
              'Logout' +
            '</button>' +
          '</form>' +

        '</div>' +

      '</header>' +

      '<main class="container">' +
        accountHtml +
        publisherHtml +
      '</main>' +

    '</div>' +

    '<script>' +

      'const BATCH = ' +
        BATCH +
      ';' +

      'function updateSelectedCount(){' +
        'const checked=document.querySelectorAll(".page-checkbox:checked");' +
        'const counter=document.getElementById("selected-count");' +
        'if(counter){counter.textContent=checked.length+" Page"+(checked.length===1?"":"s")+" Selected";}' +
      '}' +

      'function selectAccountPages(accountId,select){' +
        'document.querySelectorAll(".account-"+accountId).forEach(function(checkbox){checkbox.checked=select;});' +
        'updateSelectedCount();' +
      '}' +

      'document.addEventListener("change",function(event){' +
        'if(event.target&&event.target.classList.contains("page-checkbox")){updateSelectedCount();}' +
        'if(event.target&&event.target.id==="media"){updateMediaName();}' +
      '});' +

      'function updateMediaName(){' +
        'const input=document.getElementById("media");' +
        'const box=document.getElementById("upload-box");' +
        'if(!input||!box)return;' +
        'const strong=box.querySelector("strong");' +
        'const span=box.querySelector("span");' +
        'if(input.files&&input.files.length){' +
          'strong.textContent=input.files[0].name;' +
          'span.textContent=(input.files[0].size/1024/1024).toFixed(2)+" MB selected";' +
        '}else{' +
          'strong.textContent="Choose image or video";' +
          'span.textContent="Maximum file size: 100 MB";' +
        '}' +
      '}' +

      'const message=document.getElementById("message");' +

      'if(message){' +
        'message.addEventListener("input",function(){' +
          'const count=document.getElementById("char-count");' +
          'if(count){count.textContent=message.value.length.toLocaleString()+" / 63,206";}' +
        '});' +
      '}' +

      'const uploadBox=document.getElementById("upload-box");' +
      'const media=document.getElementById("media");' +

      'if(uploadBox&&media){' +
        'uploadBox.addEventListener("click",function(event){' +
          'if(event.target!==media){media.click();}' +
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

          'if(button){button.disabled=true;button.classList.add("loading");}' +

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
            'const allResults=[];' +

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

              'allResults.push(...data.results);' +
            '}' +

            'window.location.href="/publish-results?run_id="+encodeURIComponent(runId);' +

          '}catch(error){' +

            'console.error(error);' +

            'if(button){button.disabled=false;button.classList.remove("loading");}' +

            'if(buttonText){buttonText.textContent="Publish to Selected Pages";}' +

            'alert(error&&error.message?error.message:"Publishing failed. Please try again.");' +
          '}' +

        '});' +
      '}' +

      'document.querySelectorAll(".page-row").forEach(function(row){' +
        'row.addEventListener("click",function(event){' +
          'if(event.target.closest("button")||event.target.closest("a"))return;' +
          'const checkbox=row.querySelector(".page-checkbox");' +
          'if(!checkbox)return;' +
          'if(event.target!==checkbox&&!event.target.closest(".custom-check")){checkbox.checked=!checkbox.checked;}' +
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

      '<div class="login-background-orb orb-one"></div>' +
      '<div class="login-background-orb orb-two"></div>' +

      '<div class="login-card">' +

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

        '<div class="login-kicker">' +
          'SECURE ACCESS' +
        '</div>' +

        '<h1>' +
          'Welcome Back' +
        '</h1>' +

        '<p class="login-description">' +
          'Enter your password to access the Meta Multi Page Publisher dashboard.' +
        '</p>' +

        (
          errorMessage
            ? '<div class="login-error">' +
                escapeHtml(
                  errorMessage
                ) +
              '</div>'
            : ""
        ) +

        '<form method="POST" action="/login">' +

          '<div class="field">' +
            '<label for="password">Dashboard Password</label>' +
            '<input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter password" required />' +
          '</div>' +

          '<button class="login-submit" type="submit">' +
            'Enter Dashboard' +
          '</button>' +

        '</form>' +

        '<div class="login-footer">' +
          'Protected publishing environment' +
        '</div>' +

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
* {
  box-sizing: border-box;
}

html {
  background: #07111f;
}

body {
  margin: 0;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;

  background:
    radial-gradient(
      circle at 8% 8%,
      rgba(24,119,242,.20),
      transparent 25%
    ),
    radial-gradient(
      circle at 92% 12%,
      rgba(99,102,241,.16),
      transparent 28%
    ),
    radial-gradient(
      circle at 50% 100%,
      rgba(14,165,233,.13),
      transparent 34%
    ),
    linear-gradient(
      135deg,
      #f8fbff 0%,
      #eef4fb 45%,
      #f7faff 100%
    );

  background-attachment: fixed;

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

/* =========================================================
   PREMIUM DASHBOARD ATMOSPHERE
   ========================================================= */

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;

  opacity: .42;

  background-image:
    linear-gradient(
      rgba(24,119,242,.045) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(24,119,242,.045) 1px,
      transparent 1px
    );

  background-size: 34px 34px;

  mask-image:
    linear-gradient(
      to bottom,
      black 0%,
      rgba(0,0,0,.72) 55%,
      transparent 100%
    );
}

body::after {
  content: "";

  position: fixed;

  width: 520px;
  height: 520px;

  right: -180px;
  bottom: -220px;

  border-radius: 50%;

  pointer-events: none;
  z-index: 0;

  background:
    radial-gradient(
      circle,
      rgba(24,119,242,.14) 0%,
      rgba(99,102,241,.07) 38%,
      transparent 72%
    );

  filter: blur(8px);

  animation:
    dashboardGlow
    9s
    ease-in-out
    infinite
    alternate;
}

body > * {
  position: relative;
  z-index: 1;
}

@keyframes dashboardGlow {
  from {
    transform:
      translate3d(0,0,0)
      scale(1);

    opacity: .72;
  }

  to {
    transform:
      translate3d(-45px,-28px,0)
      scale(1.08);

    opacity: 1;
  }
}

@media (
  prefers-reduced-motion: reduce
) {
  body::after {
    animation: none;
  }
}

button,
a {
  -webkit-tap-highlight-color:
    transparent;
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

/* =========================================================
   GLOBAL
   ========================================================= */

a {
  color: inherit;
  text-decoration: none;
}

button {
  border: 0;
  cursor: pointer;
}

.container {
  width: min(
    1180px,
    calc(100% - 36px)
  );

  margin: 0 auto;
}

.dashboard-shell {
  position: relative;
  min-height: 100vh;
  padding-bottom: 70px;
}

.dashboard-glow {
  position: fixed;
  pointer-events: none;
  border-radius: 999px;
  filter: blur(60px);
  opacity: .32;
  z-index: 0;
}

.glow-a {
  width: 360px;
  height: 360px;
  top: 140px;
  left: -170px;
  background: #5b8def;
}

.glow-b {
  width: 300px;
  height: 300px;
  top: 520px;
  right: -130px;
  background: #818cf8;
}

/* =========================================================
   HERO
   ========================================================= */

.hero-header {
  width: min(
    1180px,
    calc(100% - 36px)
  );

  margin: 28px auto 34px;

  min-height: 190px;

  padding: 34px;

  border-radius: 30px;

  color: #fff;

  background:
    radial-gradient(
      circle at 82% 20%,
      rgba(56,189,248,.24),
      transparent 28%
    ),
    radial-gradient(
      circle at 15% 0%,
      rgba(96,165,250,.24),
      transparent 32%
    ),
    linear-gradient(
      135deg,
      #07152b,
      #0c2144 52%,
      #12376d
    );

  box-shadow:
    0 30px 80px
      rgba(15,35,70,.20);

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;

  position: relative;
  overflow: hidden;
}

.hero-header::before {
  content: "";
  position: absolute;
  inset: 0;

  background-image:
    linear-gradient(
      rgba(255,255,255,.035) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(255,255,255,.035) 1px,
      transparent 1px
    );

  background-size: 32px 32px;

  mask-image:
    linear-gradient(
      90deg,
      black,
      transparent
    );

  pointer-events: none;
}

.hero-brand,
.header-actions {
  position: relative;
  z-index: 1;
}

.hero-kicker {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .18em;
  opacity: .72;
  margin-bottom: 9px;
}

.hero-name {
  font-size: 12px;
  font-weight: 900;
  letter-spacing: .22em;
  color: #93c5fd;
  margin-bottom: 5px;
}

.hero-title {
  font-size: clamp(
    28px,
    4vw,
    46px
  );

  line-height: 1.05;
  font-weight: 950;
  letter-spacing: -.04em;
}

.hero-subtitle {
  margin-top: 13px;
  max-width: 670px;

  color: rgba(255,255,255,.70);

  font-size: 14px;
  line-height: 1.6;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.connect-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  min-height: 44px;

  padding: 0 17px;

  border-radius: 13px;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #0b63d1
    );

  color: #fff;

  font-size: 13px;
  font-weight: 850;

  box-shadow:
    0 12px 26px
      rgba(24,119,242,.28);

  transition:
    transform .18s ease,
    box-shadow .18s ease;
}

.connect-btn:hover {
  transform: translateY(-2px);

  box-shadow:
    0 17px 32px
      rgba(24,119,242,.35);
}

.header-logout {
  min-height: 44px;

  padding: 0 16px;

  border-radius: 13px;

  background:
    rgba(255,255,255,.08);

  border:
    1px solid
    rgba(255,255,255,.14);

  color: #fff;

  font-size: 13px;
  font-weight: 800;

  transition:
    background .18s ease,
    transform .18s ease;
}

.header-logout:hover {
  background:
    rgba(255,255,255,.14);

  transform: translateY(-1px);
}

/* =========================================================
   ACCOUNT CARD
   ========================================================= */

.account-card {
  background:
    rgba(255,255,255,.86);

  border:
    1px solid
    rgba(148,163,184,.22);

  border-radius: 24px;

  overflow: hidden;

  margin-bottom: 22px;

  box-shadow:
    0 20px 55px
      rgba(30,64,100,.09);

  backdrop-filter: blur(14px);
}

.account-top {
  padding: 23px 24px;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  background:
    linear-gradient(
      180deg,
      rgba(255,255,255,.95),
      rgba(248,251,255,.86)
    );

  border-bottom:
    1px solid
    rgba(148,163,184,.16);
}

.account-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.account-avatar {
  width: 52px;
  height: 52px;

  flex: 0 0 auto;

  border-radius: 17px;

  display: flex;
  align-items: center;
  justify-content: center;

  color: #fff;

  font-weight: 950;
  font-size: 17px;

  background:
    linear-gradient(
      145deg,
      #1877f2,
      #4f46e5
    );

  box-shadow:
    0 12px 25px
      rgba(37,99,235,.20);
}

.account-identity h2 {
  margin: 0;

  color: #142033;

  font-size: 18px;
  line-height: 1.2;
  font-weight: 900;
}

.facebook-id {
  margin-top: 6px;

  color: #7a8799;

  font-size: 11px;
}

.facebook-id code {
  color: #4c5a70;
}

.account-pages-count {
  margin-top: 7px;

  color: #1877f2;

  font-size: 11px;
  font-weight: 850;
}

.account-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.account-actions form {
  margin: 0;
}

.btn {
  min-height: 38px;

  padding: 0 13px;

  border-radius: 10px;

  font-size: 12px;
  font-weight: 850;

  transition:
    transform .18s ease,
    box-shadow .18s ease;
}

.btn:hover {
  transform: translateY(-1px);
}

.btn-blue {
  background: #e8f2ff;
  color: #1264c7;
}

.btn-blue:hover {
  box-shadow:
    0 8px 20px
      rgba(24,119,242,.12);
}

.btn-red {
  background: #fff0f0;
  color: #dc2626;
}

.btn-red:hover {
  box-shadow:
    0 8px 20px
      rgba(220,38,38,.10);
}

.pages-area {
  padding: 18px 24px 24px;
}

.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;

  margin-bottom: 12px;
}

.toolbar-title {
  color: #27364d;

  font-size: 12px;
  font-weight: 900;
  letter-spacing: .05em;
}

.toolbar-actions {
  display: flex;
  gap: 7px;
}

.toolbar-btn {
  min-height: 32px;

  padding: 0 11px;

  border-radius: 8px;

  background: #f3f6fa;

  color: #536176;

  font-size: 11px;
  font-weight: 800;
}

.toolbar-btn:hover {
  background: #e8eef6;
}

.pages-list {
  display: grid;
  gap: 7px;
}

.page-row {
  min-height: 62px;

  display: flex;
  align-items: center;
  gap: 12px;

  padding: 10px 12px;

  border-radius: 14px;

  background:
    rgba(248,250,252,.88);

  border:
    1px solid
    rgba(148,163,184,.14);

  cursor: pointer;

  transition:
    transform .16s ease,
    border-color .16s ease,
    background .16s ease;
}

.page-row:hover {
  transform: translateX(2px);

  background: #fff;

  border-color:
    rgba(24,119,242,.18);
}

.custom-check {
  width: 22px;
  height: 22px;

  flex: 0 0 auto;

  position: relative;
}

.custom-check input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.checkmark {
  position: absolute;
  inset: 0;

  border:
    2px solid
    #c9d3df;

  border-radius: 7px;

  background: #fff;

  transition:
    .15s ease;
}

.custom-check input:checked
~ .checkmark {
  border-color: #1877f2;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #2563eb
    );
}

.custom-check input:checked
~ .checkmark::after {
  content: "";

  position: absolute;

  left: 6px;
  top: 3px;

  width: 5px;
  height: 9px;

  border:
    solid #fff;

  border-width:
    0 2px 2px 0;

  transform:
    rotate(45deg);
}

.page-avatar {
  width: 38px;
  height: 38px;

  flex: 0 0 auto;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 12px;

  background:
    linear-gradient(
      145deg,
      #edf5ff,
      #e8eafe
    );

  color: #2563eb;

  font-size: 11px;
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

  color: #1e293b;

  font-size: 13px;
  font-weight: 850;
}

.page-info small {
  display: block;

  margin-top: 4px;

  color: #8a96a8;

  font-size: 10px;

  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-ready {
  display: flex;
  align-items: center;
  gap: 6px;

  color: #15956c;

  font-size: 9px;
  font-weight: 900;
  letter-spacing: .08em;
}

.ready-dot,
.selected-dot {
  width: 7px;
  height: 7px;

  border-radius: 50%;

  background: #28c78d;

  box-shadow:
    0 0 0 4px
    rgba(40,199,141,.10);
}

.empty-pages {
  padding: 24px;

  border-radius: 15px;

  text-align: center;

  background: #f8fafc;

  color: #7a8799;

  font-size: 12px;
}

/* =========================================================
   STUDIO
   ========================================================= */

.studio-card {
  margin-top: 28px;

  padding: 27px;

  border-radius: 25px;

  background:
    rgba(255,255,255,.90);

  border:
    1px solid
    rgba(148,163,184,.20);

  box-shadow:
    0 24px 65px
      rgba(30,64,100,.11);

  backdrop-filter: blur(16px);
}

.studio-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  margin-bottom: 23px;
}

.studio-title-wrap {
  display: flex;
  align-items: center;
  gap: 13px;
}

.studio-icon {
  width: 46px;
  height: 46px;

  border-radius: 14px;

  display: flex;
  align-items: center;
  justify-content: center;

  background:
    linear-gradient(
      145deg,
      #edf5ff,
      #e9eaff
    );

  color: #2563eb;

  font-size: 20px;
}

.studio-kicker {
  color: #1877f2;

  font-size: 9px;
  font-weight: 950;
  letter-spacing: .16em;

  margin-bottom: 4px;
}

.studio-heading h2 {
  margin: 0;

  color: #142033;

  font-size: 21px;
  font-weight: 950;
}

.studio-heading p {
  margin: 5px 0 0;

  color: #7c889a;

  font-size: 11px;
}

.selected-pill {
  min-height: 35px;

  padding: 0 12px;

  display: inline-flex;
  align-items: center;
  gap: 8px;

  border-radius: 999px;

  background: #eff8f5;

  color: #138660;

  font-size: 11px;
  font-weight: 850;
}

.field {
  margin-bottom: 18px;
}

.field label {
  display: block;

  margin-bottom: 8px;

  color: #334155;

  font-size: 12px;
  font-weight: 850;
}

textarea {
  width: 100%;

  min-height: 170px;

  resize: vertical;

  padding: 15px;

  border-radius: 15px;

  border:
    1px solid
    #dbe3ed;

  outline: none;

  background:
    rgba(249,251,253,.92);

  color: #172033;

  font-size: 13px;
  line-height: 1.6;

  transition:
    border-color .18s ease,
    box-shadow .18s ease;
}

textarea:focus {
  border-color: #6aa7f8;

  box-shadow:
    0 0 0 4px
    rgba(24,119,242,.08);

  background: #fff;
}

.field-meta {
  margin-top: 7px;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;

  color: #8a96a8;

  font-size: 10px;
}

#char-count {
  font-weight: 800;
}

.upload-box {
  position: relative;

  min-height: 130px;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  gap: 5px;

  padding: 20px;

  border-radius: 17px;

  border:
    1.5px dashed
    #bfd1e7;

  background:
    linear-gradient(
      180deg,
      #f8fbff,
      #f2f7fc
    );

  cursor: pointer;

  text-align: center;

  transition:
    border-color .18s ease,
    background .18s ease,
    transform .18s ease;
}

.upload-box:hover {
  border-color: #6aa7f8;

  background:
    linear-gradient(
      180deg,
      #fafdff,
      #edf5ff
    );

  transform: translateY(-1px);
}

.upload-box input {
  position: absolute;
  inset: 0;

  opacity: 0;

  cursor: pointer;
}

.upload-icon {
  width: 40px;
  height: 40px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 13px;

  background: #e7f1ff;

  color: #1877f2;

  font-size: 20px;
  font-weight: 900;

  margin-bottom: 3px;
}

.upload-box strong {
  color: #34445b;

  font-size: 12px;
  font-weight: 900;

  max-width: 90%;

  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-box span {
  color: #8b97a8;

  font-size: 10px;
}

.batch-notice {
  display: flex;
  gap: 11px;

  padding: 13px 14px;

  border-radius: 14px;

  background:
    linear-gradient(
      135deg,
      #f0f7ff,
      #f5f3ff
    );

  border:
    1px solid
    rgba(96,165,250,.14);

  margin: 3px 0 20px;
}

.batch-notice > span {
  font-size: 18px;
}

.batch-notice strong {
  display: block;

  color: #31517c;

  font-size: 11px;
}

.batch-notice p {
  margin: 3px 0 0;

  color: #718096;

  font-size: 10px;
  line-height: 1.5;
}

.publish-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
}

.publish-hint {
  color: #8995a7;

  font-size: 10px;
}

.publish-btn {
  min-height: 48px;

  padding: 0 22px;

  border-radius: 13px;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #4f46e5
    );

  color: #fff;

  font-size: 12px;
  font-weight: 900;

  box-shadow:
    0 14px 28px
      rgba(37,99,235,.22);

  transition:
    transform .18s ease,
    box-shadow .18s ease,
    opacity .18s ease;
}

.publish-btn:hover {
  transform: translateY(-2px);

  box-shadow:
    0 19px 35px
      rgba(37,99,235,.28);
}

.publish-btn:disabled {
  opacity: .65;
  cursor: wait;
}

.publish-btn.loading {
  position: relative;
}

/* =========================================================
   EMPTY STATE
   ========================================================= */

.empty-state {
  padding: 60px 25px;

  text-align: center;

  border-radius: 25px;

  background:
    rgba(255,255,255,.88);

  border:
    1px solid
    rgba(148,163,184,.20);

  box-shadow:
    0 20px 55px
      rgba(30,64,100,.08);
}

.empty-icon {
  width: 64px;
  height: 64px;

  margin: 0 auto 15px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 20px;

  background:
    linear-gradient(
      145deg,
      #e9f3ff,
      #eeeaff
    );

  color: #2563eb;

  font-size: 28px;
  font-weight: 500;
}

.empty-state h2 {
  margin: 0;

  color: #1e293b;

  font-size: 20px;
}

.empty-state p {
  margin: 8px auto 18px;

  max-width: 480px;

  color: #7c889a;

  font-size: 12px;
}

.empty-connect {
  display: inline-flex;
}

/* =========================================================
   LOGIN
   ========================================================= */

.login-page {
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  padding: 24px;

  position: relative;
  overflow: hidden;

  background:
    radial-gradient(
      circle at 15% 15%,
      rgba(24,119,242,.18),
      transparent 28%
    ),
    radial-gradient(
      circle at 85% 80%,
      rgba(99,102,241,.15),
      transparent 30%
    ),
    linear-gradient(
      135deg,
      #f7faff,
      #edf4fc
    );
}

.login-background-orb {
  position: absolute;

  border-radius: 50%;

  filter: blur(50px);

  pointer-events: none;
}

.orb-one {
  width: 300px;
  height: 300px;

  left: -110px;
  top: -100px;

  background:
    rgba(24,119,242,.12);
}

.orb-two {
  width: 330px;
  height: 330px;

  right: -130px;
  bottom: -140px;

  background:
    rgba(99,102,241,.12);
}

.login-card {
  width: min(
    450px,
    100%
  );

  padding: 34px;

  border-radius: 27px;

  background:
    rgba(255,255,255,.90);

  border:
    1px solid
    rgba(148,163,184,.22);

  box-shadow:
    0 30px 80px
      rgba(30,64,100,.13);

  backdrop-filter: blur(18px);

  position: relative;
  z-index: 2;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;

  margin-bottom: 35px;
}

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
    0 12px 28px
      rgba(24,119,242,.28);

  flex: 0 0 auto;
}

.brand-mark span {
  transform: translateY(3px);
}

.brand-mini {
  font-size: 8px;

  line-height: 1;

  font-weight: 900;

  letter-spacing: .13em;

  color: #7b8798;
}

.brand-name {
  margin-top: 5px;

  font-size: 13px;

  line-height: 1;

  font-weight: 950;

  letter-spacing: .13em;

  color: #142033;
}

.login-kicker {
  color: #1877f2;

  font-size: 10px;

  font-weight: 950;

  letter-spacing: .16em;

  margin-bottom: 8px;
}

.login-card h1 {
  margin: 0;

  color: #142033;

  font-size: 31px;

  letter-spacing: -.03em;
}

.login-description {
  margin: 9px 0 23px;

  color: #7c889a;

  font-size: 12px;

  line-height: 1.6;
}

.login-error {
  margin-bottom: 17px;

  padding: 11px 12px;

  border-radius: 11px;

  background:
    #fff0f0;

  color: #c62828;

  border:
    1px solid
    rgba(220,38,38,.12);

  font-size: 11px;

  font-weight: 750;
}

.login-submit {
  width: 100%;

  min-height: 49px;

  margin-top: 7px;

  border-radius: 13px;

  background:
    linear-gradient(
      135deg,
      #1877f2,
      #4f46e5
    );

  color: #fff;

  font-size: 13px;

  font-weight: 900;

  box-shadow:
    0 14px 30px
      rgba(37,99,235,.22);

  transition:
    transform .18s ease,
    box-shadow .18s ease;
}

.login-submit:hover {
  transform: translateY(-2px);

  box-shadow:
    0 20px 38px
      rgba(37,99,235,.29);
}

.login-footer {
  margin-top: 20px;

  padding-top: 16px;

  border-top:
    1px solid
    #edf1f5;

  text-align: center;

  color: #9aa5b5;

  font-size: 9px;

  letter-spacing: .04em;
}

/* =========================================================
   RESULTS
   ========================================================= */

.results-container {
  width: min(
    1100px,
    calc(100% - 36px)
  );

  margin: 28px auto 70px;
}

.results-topbar {
  min-height: 65px;

  padding: 0 18px;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;

  border-radius: 17px;

  background:
    rgba(255,255,255,.86);

  border:
    1px solid
    rgba(148,163,184,.20);

  box-shadow:
    0 12px 35px
      rgba(30,64,100,.07);

  backdrop-filter: blur(14px);

  margin-bottom: 25px;
}

.results-hero {
  padding: 36px 10px 22px;
}

.results-hero h1 {
  margin: 5px 0 7px;

  color: #142033;

  font-size: 39px;

  letter-spacing: -.04em;
}

.results-hero p {
  margin: 0;

  color: #7d899a;

  font-size: 13px;
}

.results-stats {
  display: grid;

  grid-template-columns:
    repeat(3,1fr);

  gap: 13px;

  margin-bottom: 20px;
}

.result-stat {
  padding: 20px;

  border-radius: 18px;

  background:
    rgba(255,255,255,.88);

  border:
    1px solid
    rgba(148,163,184,.18);

  box-shadow:
    0 14px 38px
      rgba(30,64,100,.07);
}

.result-stat span {
  display: block;

  color: #8490a1;

  font-size: 10px;

  font-weight: 800;

  margin-bottom: 7px;
}

.result-stat strong {
  color: #18263b;

  font-size: 27px;

  font-weight: 950;
}

.results-card {
  padding: 20px;

  border-radius: 21px;

  background:
    rgba(255,255,255,.90);

  border:
    1px solid
    rgba(148,163,184,.18);

  box-shadow:
    0 20px 55px
      rgba(30,64,100,.08);
}

.results-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;

  padding-bottom: 14px;

  border-bottom:
    1px solid
    #edf1f5;

  margin-bottom: 5px;
}

.results-card-header h2 {
  margin: 0;

  color: #1e293b;

  font-size: 15px;

  font-weight: 900;
}

.results-card-header span {
  color: #94a0b0;

  font-size: 9px;

  font-weight: 800;
}

.result-row {
  display: grid;

  grid-template-columns:
    1fr auto;

  gap: 10px;

  padding: 13px 5px;

  border-bottom:
    1px solid
    #f0f3f7;
}

.result-row:last-child {
  border-bottom: 0;
}

.result-row strong {
  color: #29384d;

  font-size: 12px;
}

.result-id {
  margin-top: 3px;

  color: #99a3b2;

  font-size: 9px;
}

.result-status {
  align-self: center;

  padding: 6px 9px;

  border-radius: 999px;

  font-size: 9px;

  font-weight: 900;
}

.result-status.success {
  background: #eaf9f3;
  color: #14835f;
}

.result-status.failed {
  background: #fff0f0;
  color: #cf2d2d;
}

.result-error {
  grid-column: 1 / -1;

  color: #c83b3b;

  font-size: 10px;

  line-height: 1.5;
}

/* =========================================================
   RESPONSIVE
   ========================================================= */

@media (max-width: 820px) {

  .hero-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-start;
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

  .account-actions .btn {
    width: 100%;
  }

  .results-stats {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {

  .container,
  .hero-header,
  .results-container {
    width:
      calc(100% - 24px);
  }

  .hero-header {
    margin-top: 12px;
    padding: 25px 21px;
    border-radius: 23px;
  }

  .hero-title {
    font-size: 30px;
  }

  .account-top,
  .pages-area,
  .studio-card {
    padding-left: 16px;
    padding-right: 16px;
  }

  .studio-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .selected-pill {
    width: 100%;
    justify-content: center;
  }

  .page-ready {
    display: none;
  }

  .publish-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .publish-btn {
    width: 100%;
  }

  .results-hero h1 {
    font-size: 30px;
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
    display: grid;
    grid-template-columns: 1fr;
  }

  .connect-btn,
  .header-actions form,
  .header-logout {
    width: 100%;
  }

  .header-logout {
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

