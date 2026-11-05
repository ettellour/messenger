function matchSegments(pattern, segments) {
  if (pattern.length !== segments.length) {
    return null;
  }
  const params = {};
  for (const [index, part] of pattern.entries()) {
    if (part.startsWith(":")) {
      if (segments[index] === "") {
        return null;
      }
      params[part.slice(1)] = segments[index];
    } else if (part !== segments[index]) {
      return null;
    }
  }
  return params;
}

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    this.#routes.push({ method, pattern: pattern.split("/"), handler });
  }

  // Without a match, `allowed` lists the methods the path does support, so the
  // caller can tell 404 from 405.
  find(method, path) {
    const segments = path.split("/");
    const allowed = [];
    for (const route of this.#routes) {
      const params = matchSegments(route.pattern, segments);
      if (params && route.method === method) {
        return { handler: route.handler, params };
      }
      if (params) {
        allowed.push(route.method);
      }
    }
    return { allowed };
  }
}
