/// Local data engine of the Payesh native client (row 70, ADR-43).
///
/// Same contract as `client/engine-web.js` (get/list/byRef/since/put/putMany/del/count/stats),
/// backed by SQLite with versioned migrations. Parity is proven by the shared vectors in
/// `docs/cloud/contracts/conformance/engine-v1.json`.
library;

export 'src/encrypted_database.dart';
export 'src/engine.dart';
export 'src/migrations.dart';
export 'src/sqlite_engine.dart';
