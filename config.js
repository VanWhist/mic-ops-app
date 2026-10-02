/*
 * 接続先の設定。
 * apiUrl … Apps Script Webアプリの /exec の URL。空のときはデモ表示（架空のデータ・端末内だけ）になる。
 *
 * ★ ここにはトークン・スプレッドシートID・スタッフ名を書かない（このリポジトリは公開）。
 *   URL だけではデータは読めない（スタッフごとのトークンが必要）。
 */
window.MIC_OPS_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbwElXZG2BDKB21JFnvisc2prC-J0SieiOhGWeGUzzrcoFdmkSMIslXHdvE5VS1zNmDiZA/exec'
};
