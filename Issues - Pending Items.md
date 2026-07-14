# Issues - Pending Items

## Pending Items

### 1. Create Azure AD groups (QA + PROD) per role
Create Active Directory groups for each application role, one set for QA and one for PROD (e.g. `RDARR-CCL-<Role>-QA`, `RDARR-CCL-<Role>-PROD`). One group per role per environment.

### 2. Create QA service principal for Azure AD login
Register the QA service principal / app registration so the application can authenticate users via Azure AD (Entra ID) in the QA environment. (SHDA Koustas)

### 3. Create DEV app registration for Azure AD login (service principal)
Register the DEV service principal / app registration to authenticate via Azure AD. Redirect URI for DEV: `http://localhost:4001`.

### 4. Map Azure AD groups to local roles (UI-configurable)
Map the AD groups created in item 1 to the application's local roles. The mapping must be configurable from the UI (see `client/src/views/UserManagement.tsx`).

### 5. Enforce exactly one mapped group per user
Each user must have exactly one group from the mapped list. If a user has more than one mapped group, the application must block them and show a message that they cannot proceed and must remove groups until exactly one remains. Multi-role is not allowed.

### 6. Admin users from env variable
Configure admin users via an environment variable — a comma-separated list of emails. This group will not be an active directory group

## Completed Items
