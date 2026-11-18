const { withMainActivity } = require("@expo/config-plugins");

const KOTLIN_HELPER = `
  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(rewriteShareSendIntent(intent) ?: intent)
  }

  private fun rewriteShareSendIntent(incoming: android.content.Intent?): android.content.Intent? {
    if (incoming == null) return null
    if (android.content.Intent.ACTION_SEND == incoming.action && incoming.type?.startsWith("text/") == true) {
      val sharedText = incoming.getStringExtra(android.content.Intent.EXTRA_TEXT)?.trim() ?: ""
      val sharedSubject = incoming.getStringExtra(android.content.Intent.EXTRA_SUBJECT)?.trim() ?: ""
      if (sharedText.isNotEmpty()) {
        val builder = android.net.Uri.parse("sharely://share")
          .buildUpon()
          .appendQueryParameter("text", sharedText)
        if (sharedSubject.isNotEmpty()) {
          builder.appendQueryParameter("title", sharedSubject)
        }
        incoming.action = android.content.Intent.ACTION_VIEW
        incoming.data = builder.build()
      }
    }
    return incoming
  }
`;

function injectAndroidShareIntentIntoKotlin(contents) {
  if (contents.includes("rewriteShareSendIntent")) {
    return contents;
  }
  let updated = contents;
  if (updated.includes("super.onCreate(")) {
    updated = updated.replace(
      /super\.onCreate\(/,
      "intent = rewriteShareSendIntent(intent)\n    super.onCreate(",
    );
  }
  const lastBraceIdx = updated.lastIndexOf("}");
  if (lastBraceIdx !== -1) {
    updated = `${updated.slice(0, lastBraceIdx)}${KOTLIN_HELPER}\n}\n`;
  }
  return updated;
}

function withAndroidShareIntent(config) {
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language === "kt") {
      mod.modResults.contents = injectAndroidShareIntentIntoKotlin(mod.modResults.contents);
    }
    return mod;
  });
}

module.exports = withAndroidShareIntent;
module.exports.injectAndroidShareIntentIntoKotlin = injectAndroidShareIntentIntoKotlin;
