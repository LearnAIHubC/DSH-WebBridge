export function signedInChatgptProfile(url, document, visible) {
  if (!/^https:\/\/chatgpt\.com(?:\/|$)/i.test(url) || /\/(?:auth|login|signin)(?:\/|\?|$)/i.test(url)) return false
  return Array.from(document.querySelectorAll('button[aria-label="打开个人资料菜单"],button[aria-label="Open profile menu"]'))
    .some(button => visible(button) && Boolean((button.innerText || '').trim()))
}

/** Correct a text-only login false positive without disabling real auth guards. */
export function patchChatgptLoginDetection(source) {
  if (source.includes('WebBridge: signed-in ChatGPT profile')) return source
  const marker = /const loggedIn =\r?\n\s*\/退出登录/
  if (!marker.test(source)) return source
  return source.replace(marker, `// WebBridge: signed-in ChatGPT profile is stronger evidence than words in a reply.
      const chatgptProfile = (${signedInChatgptProfile.toString()})(url, document, visible);
      const loggedIn = chatgptProfile ||
        /退出登录`)
}
