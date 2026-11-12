/// Platform roles and the UI mirror of the server's permissions (same table as `CAPS` in
/// apps/owner-panel/web/app.js). Hiding a button is not security: the server answers 403.
enum OwnerRole {
  owner('platform_owner', 'مالک پلتفرم'),
  operator('platform_operator', 'اپراتور'),
  support('platform_support', 'پشتیبان فنی');

  const OwnerRole(this.wire, this.label);
  final String wire;
  final String label;

  static OwnerRole? fromWire(Object? v) {
    for (final r in values) {
      if (r.wire == v) return r;
    }
    return null;
  }
}

/// Role label for a wire value (unknown values are shown as-is).
String roleLabel(Object? wire) => OwnerRole.fromWire(wire)?.label ?? '$wire';

final class OwnerCaps {
  const OwnerCaps({
    this.renew = false,
    this.deleteRequest = false,
    this.createPlan = false,
    this.suspend = false,
    this.approveGrant = false,
    this.revokeGrant = false,
    this.createUser = false,
    this.requestGrant = false,
    this.createSchool = false,
    this.infraRegister = false,
    this.infraCheck = false,
    this.infraRequestChange = false,
    this.infraApprove = false,
  });

  final bool renew;
  final bool deleteRequest;
  final bool createPlan;
  final bool suspend;
  final bool approveGrant;
  final bool revokeGrant;
  final bool createUser;
  final bool requestGrant;
  final bool createSchool;
  final bool infraRegister;
  final bool infraCheck;
  final bool infraRequestChange;
  final bool infraApprove;

  static const OwnerCaps none = OwnerCaps();

  static const OwnerCaps _owner = OwnerCaps(
    renew: true,
    deleteRequest: true,
    createPlan: true,
    suspend: true,
    approveGrant: true,
    revokeGrant: true,
    createUser: true,
    createSchool: true,
    infraRegister: true,
    infraCheck: true,
    infraRequestChange: true,
    infraApprove: true,
  );
  static const OwnerCaps _operator = OwnerCaps(
    suspend: true,
    requestGrant: true,
    infraRegister: true,
    infraCheck: true,
    infraRequestChange: true,
  );
  static const OwnerCaps _support = OwnerCaps(requestGrant: true);

  static OwnerCaps of(OwnerRole? role) => switch (role) {
    OwnerRole.owner => _owner,
    OwnerRole.operator => _operator,
    OwnerRole.support => _support,
    null => none,
  };

  /// Names of the granted capabilities (stable order; used by tests and diagnostics).
  List<String> get granted => [
    if (renew) 'renew',
    if (deleteRequest) 'deleteRequest',
    if (createPlan) 'createPlan',
    if (suspend) 'suspend',
    if (approveGrant) 'approveGrant',
    if (revokeGrant) 'revokeGrant',
    if (createUser) 'createUser',
    if (requestGrant) 'requestGrant',
    if (createSchool) 'createSchool',
    if (infraRegister) 'infraRegister',
    if (infraCheck) 'infraCheck',
    if (infraRequestChange) 'infraRequestChange',
    if (infraApprove) 'infraApprove',
  ];
}
