import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../auth/auth_tokens.dart';
import '../config/app_config.dart';
import 'token_storage.dart';

/// 認証まわりを差し込む dio インターセプタ。
///
/// - リクエスト時: 保管済みアクセストークンを `Authorization: Bearer` に載せる。
/// - 401 応答時: リフレッシュトークンで再発行を試み、成功したら元リクエストを1回だけ再試行する。
///   再発行に失敗（＝セッション失効）したらトークンを破棄し、認証状態を未認証へ倒す
///   （ルーターがログイン画面へリダイレクトする）。
///
/// `QueuedInterceptorsWrapper` を使うことで、同時多発の 401 のエラー処理を直列化し、
/// リフレッシュが何本も走るのを避ける。
class AuthInterceptor extends QueuedInterceptorsWrapper {
  AuthInterceptor({
    required this.storage,
    required this.baseUrl,
    required this.onSessionExpired,
  });

  final TokenStorage storage;
  final String baseUrl;

  /// セッション失効（リフレッシュ不能）を上位へ通知するコールバック。
  final void Function() onSessionExpired;

  /// リフレッシュ/リトライ用の素の Dio（インターセプタ無し＝再帰ループ防止）。
  Dio _bareDio() => Dio(BaseOptions(baseUrl: baseUrl));

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final access = await storage.readAccessToken();
    if (access != null && access.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $access';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final is401 = err.response?.statusCode == 401;
    final alreadyRetried = err.requestOptions.extra['__retried__'] == true;
    // /auth/refresh 自体の 401 はリフレッシュ不能（＝失効）。ループ防止に対象外とする。
    final isRefreshCall = err.requestOptions.path.contains('/auth/refresh');

    if (!is401 || alreadyRetried || isRefreshCall) {
      handler.next(err);
      return;
    }

    final refreshed = await _tryRefresh();
    if (!refreshed) {
      // 再発行できない＝セッション失効。トークンを捨てて未認証へ。
      await storage.clear();
      onSessionExpired();
      handler.next(err);
      return;
    }

    // 新しいアクセストークンで元リクエストを1回だけ再試行する。
    try {
      final newAccess = await storage.readAccessToken();
      final opts = err.requestOptions
        ..extra['__retried__'] = true
        ..headers['Authorization'] = 'Bearer $newAccess';
      final response = await _bareDio().fetch<dynamic>(opts);
      handler.resolve(response);
    } on DioException catch (retryErr) {
      handler.next(retryErr);
    }
  }

  /// リフレッシュトークンでトークン一式を再発行し、保管を更新する。
  /// @returns 成功したら true（失敗＝失効は false）
  Future<bool> _tryRefresh() async {
    final refresh = await storage.readRefreshToken();
    if (refresh == null || refresh.isEmpty) return false;
    try {
      final res = await _bareDio().post<dynamic>(
        '/auth/refresh',
        data: {'refresh_token': refresh},
      );
      final tokens = AuthTokens.fromJson(Map<String, dynamic>.from(res.data as Map));
      await storage.save(tokens);
      return true;
    } on DioException {
      return false;
    }
  }
}

/// アプリ共通の設定済み dio。
///
/// ベース URL・JSON ヘッダ・認証インターセプタを備える。認証エンドポイント（register/login/
/// refresh）は security 不要だが、Bearer が付いても無害なので一律付与する。
final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      headers: {'Content-Type': 'application/json'},
    ),
  );
  dio.interceptors.add(
    AuthInterceptor(
      storage: ref.read(tokenStorageProvider),
      baseUrl: AppConfig.apiBaseUrl,
      // 失効時は認証状態を未認証へ倒す（ルーターがログインへ誘導）。
      onSessionExpired: () => ref.read(authControllerProvider.notifier).markSessionExpired(),
    ),
  );
  return dio;
});
