// Set a fake test key in localStorage (we already know the real one returns 401;
// this proves the wiring works end-to-end without needing a valid MiniMax key).
const fakeKey = "sk-test-fake-key-for-wiring-verification";
localStorage.setItem("tradepass.minimaxKey", fakeKey);
localStorage.setItem("tradepass.minimaxBaseUrl", "https://api.minimaxi.com/v1");
return "stored:" + fakeKey.substring(0, 12) + "...";
