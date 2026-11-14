import { createClient } from '@supabase/supabase-js';

/**
 * Sin login: todos los dispositivos que abren la app comparten este mismo inventario
 * con la clave pública (anon). La protege la política RLS del proyecto, no un secreto:
 * cualquiera con esta URL puede leer y escribir. Aceptado a propósito (app de un solo usuario).
 */
const FALLBACK_URL = 'https://qmlyaqwwmuexgmlinzjt.supabase.co';
const FALLBACK_ANON_KEY = 'sb_publishable_mSkJJR8oMNjGX6auLBtJeQ_WS0bwKCx';

const url = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;

export const supabase = createClient(url, anonKey);
