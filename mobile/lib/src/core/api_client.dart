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
/// **多重リフレッシュ防止**: 同時に複数リクエストが 401 になっても、進行中の refresh 呼び出しを
/// 1 本の Future として共有（in-flight de-duplication）する。これにより `/auth/refresh` は 1 回だけ
/// 呼ばれ、リフレッシュトークンのローテーション（失効済み再使用→family 系統失効）による意図しない
/// 強制再ログインを防ぐ。
///
/// リフレッシュ／リトライは**インターセプタを持たない専用の dio**（[refreshClient]）で行う
/// （自インターセプタを再帰的に通さないため）。テストではこの refreshClient にモックアダプタを
/// 差し込んで 401→refresh→retry の分岐を検証できる。
class AuthInterceptor extends InterceptorsWrapper {
  AuthInterceptor({
    required this.storage,
    required this.refreshClient,
    required this.onSessionExpired,
  });

  final TokenStorage storage;

  /// リフレッシュ／リトライ用の dio（インターセプタ無し＝再帰ループ防止）。
  final Dio refreshClient;

  /// セッション失効（リフレッシュ不能）を上位へ通知するコールバック。
  final void Function() onSessionExpired;

  /// 進行中の refresh。null でなければ既に走っている＝それを待つ（多重発火防止）。
  Future<bool>? _inflightRefresh;

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

    final refreshed = await _refreshOnce();
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
      final response = await refreshClient.fetch<dynamic>(opts);
      handler.resolve(response);
    } on DioException catch (retryErr) {
      handler.next(retryErr);
    }
  }

  /// 進行中の refresh があればそれを待ち、無ければ 1 本開始する（in-flight 共有）。
  Future<bool> _refreshOnce() {
    return _inflightRefresh ??= _doRefresh().whenComplete(() => _inflightRefresh = null);
  }

  /// リフレッシュトークンでトークン一式を再発行し、保管を更新する。
  /// @returns 成功したら true（失敗＝失効は false）
  Future<bool> _doRefresh() async {
    final refresh = await storage.readRefreshToken();
    if (refresh == null || refresh.isEmpty) return false;
    try {
      final res = await refreshClient.post<dynamic>(
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
  BaseOptions baseOptions() => BaseOptions(
        baseUrl: AppConfig.apiBaseUrl,
        headers: {'Content-Type': 'application/json'},
      );
  final dio = Dio(baseOptions());
  // リフレッシュ／リトライ用の素の dio（インターセプタ無し）。BaseOptions は共有せず別インスタンスに
  // し、一方の options.headers 変更が他方へ波及するのを防ぐ。
  final refreshClient = Dio(baseOptions());
  dio.interceptors.add(
    AuthInterceptor(
      storage: ref.read(tokenStorageProvider),
      refreshClient: refreshClient,
      // 失効時は認証状態を未認証へ倒す（ルーターがログインへ誘導）。
      onSessionExpired: () => ref.read(authControllerProvider.notifier).markSessionExpired(),
    ),
  );
  return dio;
});
