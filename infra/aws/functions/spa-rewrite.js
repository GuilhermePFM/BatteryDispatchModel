// Viewer request, default behaviour only (so never /api/*): a path whose last
// segment has no dot is a client-side route of the SPA, served by index.html.
// Doing it here instead of with custom error responses keeps the API's own
// 404s and 403s intact, and makes /index.html the cache key of every route.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
