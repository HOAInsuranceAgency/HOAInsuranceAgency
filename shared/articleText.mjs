/**
 * Count prose words consistently for editorial checks, publishing and reading time.
 * Markdown link destinations and reference definitions are not article prose.
 * @param {string} body
 * @returns {number}
 */
export function articleWordCount(body) {
  return body.replace(/\[[^\]]*\]\([^)]*\)/g, (link) => link.slice(1, link.indexOf("]")))
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
    .match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
