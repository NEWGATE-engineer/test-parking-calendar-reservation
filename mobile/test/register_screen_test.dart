import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/auth/auth_repository.dart';
import 'package:mobile/src/auth/register_screen.dart';
import 'package:mobile/src/core/token_storage.dart';

import 'helpers/fake_auth_repository.dart';
import 'helpers/fake_token_storage.dart';

/// 新規登録画面のスモークテストと、規約未同意時に登録APIを呼ばない回帰保護。
void main() {
  Future<FakeAuthRepository> pump(WidgetTester tester) async {
    final repo = FakeAuthRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tokenStorageProvider.overrideWithValue(FakeTokenStorage()),
          authRepositoryProvider.overrideWithValue(repo),
        ],
        child: const MaterialApp(home: RegisterScreen()),
      ),
    );
    return repo;
  }

  testWidgets('入力欄と登録ボタン・規約チェックが描画される', (tester) async {
    await pump(tester);
    expect(find.text('メールアドレス'), findsOneWidget);
    expect(find.text('利用規約に同意する'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '登録する'), findsOneWidget);
  });

  testWidgets('規約未同意で送信すると登録APIを呼ばずエラーを表示する', (tester) async {
    final repo = await pump(tester);

    // 有効な入力（バリデーションは通る）だがチェックは付けない
    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), 'e@x.com');
    await tester.enterText(fields.at(1), 'password1');

    await tester.tap(find.widgetWithText(FilledButton, '登録する'));
    await tester.pump();

    expect(find.text('利用規約への同意が必要です'), findsOneWidget);
    expect(repo.registerCalled, false); // API は呼ばれない
  });

  testWidgets('規約同意＋有効入力で登録APIを呼ぶ', (tester) async {
    final repo = await pump(tester);

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), 'e@x.com');
    await tester.enterText(fields.at(1), 'password1');
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, '登録する'));
    await tester.pump();

    expect(repo.registerCalled, true);
  });
}
