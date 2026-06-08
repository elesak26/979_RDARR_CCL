import { api } from '../api/client';
import type { User } from '../types';

export async function getMe(): Promise<User> {
  return api.get<User>('/users/me');
}

export async function getAllUsers(): Promise<User[]> {
  return api.get<User[]>('/users');
}
