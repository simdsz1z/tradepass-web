// Diagnostic — dump what's in localStorage and what the server sees.
const k = localStorage.getItem("tradepass.minimaxKey");
const b = localStorage.getItem("tradepass.minimaxBaseUrl");
return {
  hasKey: !!k,
  keyLen: k ? k.length : 0,
  keyPrefix: k ? k.substring(0, 6) : null,
  keySuffix: k ? k.substring(k.length - 4) : null,
  baseUrl: b,
  hasUserPill: !!document.getElementById("user-pill"),
  hasSettingsBtn: !!document.getElementById("settings-btn"),
  pageUrl: location.href,
};
