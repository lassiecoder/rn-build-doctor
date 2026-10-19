export const API_URL = 'http://192.168.1.20:3000/api';

export async function getProfile() {
  const res = await fetch(`${API_URL}/profile`);
  return res.json();
}
