import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';

/// ApiException.fromDio の写像を検証する（UI のエラー分岐の土台）。
void main() {
  RequestOptions opts() => RequestOptions(path: '/x');

  group('ApiException.fromDio', () {
    test('Error スキーマ本文を code/message/retryable に写す', () {
      final e = DioException(
        requestOptions: opts(),
        response: Response<dynamic>(
          requestOptions: opts(),
          statusCode: 409,
          data: {'code': 'conflict_overlap', 'message': '重複', 'retryable': false},
        ),
      );
      final ex = ApiException.fromDio(e);
      expect(ex.statusCode, 409);
      expect(ex.code, 'conflict_overlap');
      expect(ex.message, '重複');
      expect(ex.retryable, false);
    });

    test('retry_after を拾う', () {
      final e = DioException(
        requestOptions: opts(),
        response: Response<dynamic>(
          requestOptions: opts(),
          statusCode: 504,
          data: {'code': 'timeout', 'message': '無応答', 'retryable': true, 'retry_after': 5},
        ),
      );
      final ex = ApiException.fromDio(e);
      expect(ex.retryable, true);
      expect(ex.retryAfter, 5);
    });

    test('応答なし（接続失敗）は network・retryable=true', () {
      final e = DioException(
        requestOptions: opts(),
        type: DioExceptionType.connectionError,
      );
      final ex = ApiException.fromDio(e);
      expect(ex.statusCode, isNull);
      expect(ex.code, 'network');
      expect(ex.retryable, true);
    });

    test('本文が Error スキーマでない場合は unknown', () {
      final e = DioException(
        requestOptions: opts(),
        response: Response<dynamic>(
          requestOptions: opts(),
          statusCode: 500,
          data: 'Internal Server Error',
        ),
      );
      final ex = ApiException.fromDio(e);
      expect(ex.code, 'unknown');
      expect(ex.statusCode, 500);
    });
  });
}
