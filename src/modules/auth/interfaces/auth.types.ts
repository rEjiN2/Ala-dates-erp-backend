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

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: {
    id: string;
    name: string;
  };
  permissions: string[];
}
