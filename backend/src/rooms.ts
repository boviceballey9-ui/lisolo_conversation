// Noms des rooms Socket.io (partagés par socket.ts et les appels).

// Room personnelle d'un utilisateur : tous ses onglets / appareils connectés y sont.
// Pour envoyer quelque chose à un utilisateur, on émet vers sa room.
export const userRoom = (userId: string) => `user:${userId}`;

// Room d'un groupe : tous les sockets de tous ses membres. Un message de groupe
// est émis UNE fois vers cette room, Socket.io le distribue à chacun.
export const groupRoom = (groupId: string) => `group:${groupId}`;
