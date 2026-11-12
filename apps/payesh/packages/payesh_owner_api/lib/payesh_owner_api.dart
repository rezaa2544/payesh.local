/// Native owner-panel client (row 126): the `/api/platform/v1` contract of the retired
/// WebView panel, in Dart. Authorization stays on the server (edge role check + SQL
/// `require_actor`); the role here only hides buttons, exactly like the web panel did.
library;

export 'src/api.dart';
export 'src/caps.dart';
export 'src/claims.dart';
export 'src/errors.dart';
export 'src/origin.dart';
export 'src/rules.dart';
export 'src/transport.dart';
