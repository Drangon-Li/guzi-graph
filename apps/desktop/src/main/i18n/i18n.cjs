const english = require("./en.json");

function translate(language, message, values = {}) {
  const template = language === "en" ? english[message] || message : message;
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

module.exports = { translate };
