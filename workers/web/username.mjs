// Preserve the pre-Workers adjective/animal/two-digit naming style.
const adjectives = 'Swift Bold Brave Calm Cool Dark Deep Fast Fierce Free Grand Happy Keen Kind Light Lucky Mild Noble Quick Rare Sharp Shy Sly Smart Soft Still Tall True Vast Warm Wild Wise Bold Bright Clear Crisp Fair Fine Fresh Gentle Glad Great Lush Neat Pure Rich Safe Slim Strong Vivid'.split(' ');
const animals = 'Hawk Bear Wolf Lion Fox Deer Dove Eagle Falcon Heron Otter Panda Raven Tiger Whale Crane Drake Finch Gecko Hound Koala Lemur Moose Newt Owl Puma Quail Robin Shark Swan Trout Viper Wren Yak Bison Cedar Dingo Egret Ferret Grouse Ibis Jackal Kite Llama Marten Narwhal Osprey Parrot Quetzal Raptor'.split(' ');
const storageKey = 'watchparty_username';
const cookieKey = 'byob_username';
const migratedKey = 'byob_username_cookie_migrated';
const validName = value => typeof value === 'string' && value.trim() && value.trim().length <= 30 ? value.trim() : null;

export function createUsernamePreference({ window = globalThis.window, document = globalThis.document, random = Math.random } = {}) {
  function save(value) {
    const name = validName(value);
    if (!name) throw new Error('invalid_username');
    try {
      window.localStorage.setItem(storageKey, name);
      window.localStorage.setItem(migratedKey, '1');
    } catch {}
    try {
      // localStorage is origin-local. A preference cookie also survives a
      // switch between the supported apex/www hosts or cleared local storage.
      const domain = ['byob.video', 'www.byob.video'].includes(window.location.hostname) ? '; Domain=byob.video' : '';
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${cookieKey}=${encodeURIComponent(name)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}${domain}`;
    } catch {}
    return name;
  }
  function read() {
    let name, stored, migrated = false;
    try {
      stored = validName(window.localStorage.getItem(storageKey));
      migrated = window.localStorage.getItem(migratedKey) === '1';
    } catch {}
    try {
      const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieKey}=`));
      if (cookie) name = validName(decodeURIComponent(cookie.slice(cookieKey.length + 1)));
    } catch {}
    // Migrate each origin's legacy preference once before letting the shared
    // cookie win. Visiting the other host must not erase an old custom name.
    if (stored && !migrated) name = stored;
    if (!name) name = stored;
    if (!name) name = `${adjectives[Math.floor(random() * adjectives.length)]}${animals[Math.floor(random() * animals.length)]}${String(1 + Math.floor(random() * 99)).padStart(2, '0')}`;
    return save(name);
  }
  return { read, save };
}
