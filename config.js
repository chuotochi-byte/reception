const CONFIG = {
  ANNOUNCE_DELAY_SEC:  5,
  OPEN_HOUR:  9,
  CLOSE_HOUR: 17,

  // Dropbox連携はsetup.html経由のOAuth (PKCE) で取得したトークンを
  // localStorage (dbx_access_token / dbx_refresh_token) で管理しているため、
  // ここに固定トークンを直書きする必要はない（app.jsのgetDropboxToken参照）。

  // Anthropic APIキー（AIによる人物検知に使用）
  // https://console.anthropic.com/ で取得してここに貼り付け
  ANTHROPIC_API_KEY: '',

  VOICE_GUIDANCE: 'いらっしゃいませ。そのままお名前とご用件とご連絡先を口頭でお話しください。話し終わりましたら送信ボタンを押してください。',
  DONE_RESET_MINUTES: 1,
};
