/// 認証トークン一式（OpenAPI の TokenResponse に対応）。
///
/// access は短命（15分）・ステートレス検証、refresh は長命（14日）で再発行に使う
/// （認証設計 §2）。アプリはこの2本を安全なストレージに保管する。
class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
  });

  /// Bearer で送るアクセストークン（JWT）。
  final String accessToken;

  /// アクセストークン失効時に再発行するためのリフレッシュトークン。
  final String refreshToken;

  /// アクセストークンの有効秒数（サーバ提示。MVP では未使用だが将来の先行更新用に保持）。
  final int expiresIn;

  /// TokenResponse の JSON からパースする。
  factory AuthTokens.fromJson(Map<String, dynamic> json) {
    return AuthTokens(
      accessToken: json['access_token'] as String,
      refreshToken: json['refresh_token'] as String,
      expiresIn: json['expires_in'] as int,
    );
  }
}
