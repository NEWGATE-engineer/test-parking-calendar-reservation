// テスト用の環境変数を用意（config が起動時に必須チェックするため）。
// 実際の DB には接続しない単体テスト用のダミー値。
process.env['JWT_SECRET'] ??= 'test-secret-not-for-prod';
process.env['SQL_CONNECTION_STRING'] ??=
  'Server=localhost,1433;Database=parking_test;User ID=sa;Password=x;Encrypt=true;TrustServerCertificate=true;';
