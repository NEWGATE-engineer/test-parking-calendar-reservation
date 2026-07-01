import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../auth/auth_tokens.dart';

/// アクセス／リフレッシュトークンの安全な保管層。
///
/// `flutter_secure_storage` を使う（モバイルは Keychain/Keystore、Web は WebCrypto+localStorage）。
/// 平文の SharedPreferences には置かない。保管する値は「サーバ発行のトークン」だけで、
/// パスワードは保持しない。
class TokenStorage {
  TokenStorage([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _kAccess = 'access_token';
  static const _kRefresh = 'refresh_token';

  /// トークン一式を保存する（ログイン・登録・再発行の成功時）。
  Future<void> save(AuthTokens tokens) async {
    // 2 値は必ずセットで更新する（片方だけ残ると不整合になるため）。
    await _storage.write(key: _kAccess, value: tokens.accessToken);
    await _storage.write(key: _kRefresh, value: tokens.refreshToken);
  }

  /// アクセストークンを読む（無ければ null）。
  Future<String?> readAccessToken() => _storage.read(key: _kAccess);

  /// リフレッシュトークンを読む（無ければ null）。
  Future<String?> readRefreshToken() => _storage.read(key: _kRefresh);

  /// 保管済みのトークンをすべて破棄する（ログアウト・セッション失効時）。
  Future<void> clear() async {
    await _storage.delete(key: _kAccess);
    await _storage.delete(key: _kRefresh);
  }
}

/// アプリ全体で共有する {@link TokenStorage}。テストでは override して差し替える。
final tokenStorageProvider = Provider<TokenStorage>((ref) => TokenStorage());
