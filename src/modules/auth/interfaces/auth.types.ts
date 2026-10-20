import type { DataScope } from '../../roles/permissions.js';
import type { StaffType } from '../../cashier/schemas/cashier.schema.js';

export interface JwtAccessPayload {
  sub: string;
  tokenType: 'access';
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
}

export interface JwtRefreshPayload {
  sub: string;
  tokenType: 'refresh';
}

/**
 * The request user, rebuilt from the database on every request (see
 * JwtAccessStrategy), so role, scope and status changes apply at once.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: {
    id: string;
    name: string;
  };
  permissions: string[];
  /** Absent only on hand-built users (tests, scripts); treated as "all". */
  dataScope?: DataScope;
  /** Cash/wallet accounts an "own"-scoped user may receive money into. */
  allowedCashAccountIds?: string[];
  mustChangePassword?: boolean;
}

/** GET /auth/me (and the login response). */
export interface AuthProfile extends AuthenticatedUser {
  dataScope: DataScope;
  mustChangePassword: boolean;
  /** The linked staff record (Cashier master). */
  linkedCashier: {
    id: string;
    code: string;
    name: string;
    status: string;
    staffType: StaffType;
    settlesWithOffice: boolean;
  } | null;
  allowedCashAccounts: { id: string; code: string; name: string; type: string }[];
}
