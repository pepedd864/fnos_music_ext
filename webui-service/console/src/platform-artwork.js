// Official artwork is bundled locally; never guess a logo for an unknown channel.
export const platformArtwork = {
  qq: 'qq.jpg', kugou: 'kugou.jpg', kuwo: 'kuwo.jpg', netease: 'netease.jpg',
  migu: 'migu.jpg', bilibili: 'bilibili.jpg', bodian: 'bodian.jpg', soda: 'soda.jpg',
  qianqian: 'qianqian.jpg', fivesing: 'fivesing.jpg', streetvoice: 'streetvoice.jpg',
  ximalaya: 'ximalaya.jpg', qingting: 'qingting.jpg', lizhi: 'lizhi.jpg', lrts: 'lrts.jpg',
  apple: 'apple.jpg', itunes: 'itunes.jpg', audius: 'audius.jpg', deezer: 'deezer.jpg',
  jiosaavn: 'jiosaavn.jpg', joox: 'joox.jpg', moov: 'moov.jpg', qobuz: 'qobuz.jpg',
  soundcloud: 'soundcloud.jpg', spotify: 'spotify.jpg', suno: 'suno.jpg', tidal: 'tidal.jpg',
  youtube: 'youtube.jpg', jamendo: 'jamendo.png', fma: 'fma.svg', wikimediacommons: 'wikimediacommons.svg',
};

export function platformLogo(id) {
  const file = platformArtwork[String(id || '').replace(/MusicClient$/i, '').toLowerCase()];
  return file ? `/app/fnmusic-ext/static/console/platforms/${file}?v=20261024` : undefined;
}
