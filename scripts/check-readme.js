const s = require("fs").readFileSync("README.md", "utf8");
const m = s.match(/https?:\/\/[^\s)"']+\.svg/gi);
if (!m) {
  console.log("README: no SVGs");
  process.exit(0);
}

// Badge services that vsce allows
const allowed = [
  "img.shields.io",
  "badge.fury.io",
  "badges.gitter.im",
  "travis-ci.org",
  "ci.appveyor.com",
  "david-dm.org",
];

const blocked = m.filter((url) => !allowed.some((host) => url.includes(host)));
if (blocked.length > 0) {
  console.error("SVGs in README.md (blocked by vsce):");
  blocked.forEach((u) => console.error(" ", u));
  process.exit(1);
} else {
  console.log("README: no blocked SVGs (" + m.length + " allowed badge(s))");
}
