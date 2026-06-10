export type CycleStatus = 'draft' | 'pending_approval' | 'published' | 'distributed' | 'closed';
export type ResponseStatus = 'draft' | 'in_progress' | 'submitted' | 'returned';
export type ValidationStatus = 'pending' | 'in_review' | 'returned' | 'rejected' | 'pending_approval' | 'closed';
export type UserRole = 'Admin' | 'Validator' | 'Senior Validator' | 'Responder' | 'Viewer';

export interface User {
  id: string;
  display_name: string;
  role: UserRole;
  unit_codes: string[];
  primary_unit_code: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at?: string;
}

export interface LoginHistoryEntry {
  id: number;
  user_id: string;
  display_name: string;
  role: string;
  logged_in_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface Cycle {
  id: number;
  name: string;
  year: number;
  status: CycleStatus;
  created_by: string | null;
  published_at: string | null;
  distributed_at: string | null;
  closed_at: string | null;
  description: string | null;
  rejection_comment: string | null;
  checklist_file: string | null;
  created_at: string;
  updated_at: string;
}

export interface Question {
  id: number;
  item_number: number;
  thematic_area: string;
  requirement: string;
  bcbs_principle_number: number | null;
  bcbs_principle_name: string | null;
  ecb_reference: string | null;
  expectations: string | null;
  score_1_desc: string | null;
  score_2_desc: string | null;
  score_3_desc: string | null;
  score_4_desc: string | null;
  respondents_hint: string | null;
  supportive_material: string | null;
  related_kpis: string | null;
}

export interface Response {
  id: number;
  cycle_id: number;
  question_id: number;
  bu_code: string;
  material_risk: string | null;
  status: ResponseStatus;
  compliance_score: number | null;
  comments: string | null;
  responder_id: string | null;
  responder_name: string | null;
  submitted_at: string | null;
  return_comment: string | null;
  returned_at: string | null;
  created_at: string;
  updated_at: string;
  // joined
  item_number?: number;
  thematic_area?: string;
  requirement?: string;
  bcbs_principle_number?: number | null;
  bcbs_principle_name?: string | null;
  expectations?: string | null;
  score_1_desc?: string | null;
  score_2_desc?: string | null;
  score_3_desc?: string | null;
  score_4_desc?: string | null;
}

export interface Validation {
  id: number;
  cycle_id: number;
  question_id: number;
  status: ValidationStatus;
  validation_score: number | null;
  justification: string | null;
  additional_controls: string | null;
  validated_by: string | null;
  validated_at: string | null;
  senior_validated_by?: string | null;
  senior_validated_at?: string | null;
  senior_rejection_comment?: string | null;
  workflow_history: WorkflowEvent[];
  created_at: string;
  updated_at: string;
  // joined
  item_number?: number;
  thematic_area?: string;
  requirement?: string;
  // side-by-side responses (from GET /validations/:id)
  bu_responses?: Response[];
  responses?: Response[];
}

export interface WorkflowEvent {
  timestamp: string;
  action: string;
  actor_id: string;
  actor_name: string;
  comment?: string;
}

export interface CycleComment {
  id: number;
  user_id: string;
  user_name: string;
  user_role: string;
  body: string;
  created_at: string;
}

export interface Attachment {
  id: number;
  response_id: number;
  file_name: string;
  file_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
}
