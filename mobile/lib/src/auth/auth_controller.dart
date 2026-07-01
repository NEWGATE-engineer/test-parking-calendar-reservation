import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/token_storage.dart';
import 'auth_repository.dart';

/// 認証状態。ルーターのゲーティング（画面設計 §認証ゲーティング）に使う。
enum AuthStatus {
  /// 起動直後、保管トークンの有無を確認中（スプラッシュ表示）。
  unknown,

  /// 認証済み（保護画面にアクセス可）。
  authenticated,

  /// 未認証（ログイン／登録のみ）。
  unauthenticated,
}

/// 認証状態を保持し、ログイン・登録・ログアウトを担うコントローラ。
///
/// - 状態（{@link AuthStatus}）は**ルーティングの判断にのみ**使う。
/// - login/register は失敗時に {@link ApiException} を投げるので、画面側で loading/error を扱う
///   （このコントローラは画面ごとの送信中状態は持たない＝関心の分離）。
class AuthController extends Notifier<AuthStatus> {
  @override
  AuthStatus build() {
    // 起動時は不明状態から始め、保管トークンの有無で初期状態を決める（非同期）。
    _restore();
    return AuthStatus.unknown;
  }

  TokenStorage get _storage => ref.read(tokenStorageProvider);
  AuthRepository get _repo => ref.read(authRepositoryProvider);

  /// 保管済みリフレッシュトークンの有無で初期認証状態を復元する。
  ///
  /// トークンの有効性までは検証しない（失効していても、最初の保護 API 呼び出しで 401 →
  /// インターセプタが失効を検知して未認証へ倒す＝自己修復する）。
  Future<void> _restore() async {
    final refresh = await _storage.readRefreshToken();
    state = (refresh != null && refresh.isNotEmpty)
        ? AuthStatus.authenticated
        : AuthStatus.unauthenticated;
  }

  /// ログイン。成功でトークンを保管し認証済みへ。
  /// @throws ApiException 認証失敗など（画面側で表示）
  Future<void> login({required String email, required String password}) async {
    final tokens = await _repo.login(email: email, password: password);
    await _storage.save(tokens);
    state = AuthStatus.authenticated;
  }

  /// 会員登録。成功でトークンを保管し認証済みへ。
  /// @throws ApiException メール重複・入力不正など（画面側で表示）
  Future<void> register({
    required String email,
    required String password,
    String? name,
  }) async {
    final tokens = await _repo.register(email: email, password: password, name: name);
    await _storage.save(tokens);
    state = AuthStatus.authenticated;
  }

  /// ログアウト。サーバ失効（ベストエフォート）＋端末トークン破棄＋未認証へ。
  Future<void> logout() async {
    final refresh = await _storage.readRefreshToken();
    if (refresh != null && refresh.isNotEmpty) {
      await _repo.logout(refresh);
    }
    await _storage.clear();
    state = AuthStatus.unauthenticated;
  }

  /// インターセプタからの失効通知で未認証へ倒す（トークン破棄はインターセプタが実施済み）。
  void markSessionExpired() {
    state = AuthStatus.unauthenticated;
  }
}

/// アプリ共通の認証コントローラ。
final authControllerProvider =
    NotifierProvider<AuthController, AuthStatus>(AuthController.new);
