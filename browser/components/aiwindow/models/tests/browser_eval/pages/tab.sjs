/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Serves a static page titled with the `title` query parameter. Used for tabs
// from data/tab_catalog.sys.mjs. Query strings are not part of Smart Window's
// URL tokens, so the model only sees the title.

function escapeForHTML(text) {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === "&") {
      result += "&amp;";
    } else if (char === "<") {
      result += "&lt;";
    } else if (char === ">") {
      result += "&gt;";
    } else if (code > 127) {
      // httpd writes strings as single bytes, so send non-ASCII as entities.
      result += `&#${code};`;
    } else {
      result += char;
    }
  }
  return result;
}

function handleRequest(request, response) {
  let title = "";
  for (const pair of request.queryString.split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key === "title") {
      title = decodeURIComponent(value.replace(/\+/g, " "));
    }
  }
  const escaped = escapeForHTML(title);
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escaped}</title></head>` +
      `<body><h1>${escaped}</h1></body></html>`
  );
}
