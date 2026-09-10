/** Factions, warehouses, rumours, buried treasure and the seasonal ledger. */
export default {
  faction: {
    nordmark: { de: 'Nordmark', en: 'Northmark', it: 'Marca del Nord', fr: 'Marche du Nord', zh: '北境同盟', ru: 'Северная марка' },
    sonnenbund: { de: 'Sonnenbund', en: 'Sun League', it: 'Lega del Sole', fr: 'Ligue du Soleil', zh: '烈日同盟', ru: 'Солнечный союз' },
    ostkrone: { de: 'Ostkrone', en: 'Eastern Crown', it: 'Corona d’Oriente', fr: 'Couronne d’Orient', zh: '东方王冠', ru: 'Восточная корона' },
    inselraete: { de: 'Inselräte', en: 'Island Councils', it: 'Consigli delle Isole', fr: 'Conseils des Îles', zh: '群岛议会', ru: 'Островные советы' },
    freihandel: { de: 'Freihandelsbund', en: 'Free Trade League', it: 'Lega del Libero Scambio', fr: 'Ligue du Libre-Échange', zh: '自由贸易联盟', ru: 'Лига свободной торговли' },
    schwarzflagge: { de: 'Schwarzflagge', en: 'Black Flag', it: 'Bandiera Nera', fr: 'Pavillon Noir', zh: '黑旗', ru: 'Чёрный флаг' },
    relations: { de: 'Beziehungen', en: 'Relations', it: 'Relazioni', fr: 'Relations', zh: '关系', ru: 'Отношения' },
    atWar: { de: 'Im Krieg', en: 'At war', it: 'In guerra', fr: 'En guerre', zh: '交战中', ru: 'В состоянии войны' },
    atPeace: { de: 'Frieden', en: 'At peace', it: 'In pace', fr: 'En paix', zh: '和平', ru: 'Мир' },
    warDeclared: { de: '{a} und {b} liegen im Krieg.', en: '{a} and {b} are at war.', it: '{a} e {b} sono in guerra.', fr: '{a} et {b} sont en guerre.', zh: '{a} 与 {b} 开战。', ru: '{a} и {b} в состоянии войны.' },
    peaceMade: { de: '{a} und {b} haben Frieden geschlossen.', en: '{a} and {b} have made peace.', it: '{a} e {b} hanno fatto pace.', fr: '{a} et {b} ont fait la paix.', zh: '{a} 与 {b} 已议和。', ru: '{a} и {b} заключили мир.' },
  },

  warehouse: {
    title: { de: 'Lagerhaus', en: 'Warehouse', it: 'Magazzino', fr: 'Entrepôt', zh: '仓库', ru: 'Склад' },
    rent: { de: 'Lager mieten', en: 'Rent storage', it: 'Affitta un magazzino', fr: 'Louer un entrepôt', zh: '租用仓库', ru: 'Арендовать склад' },
    none: { de: 'In diesem Hafen hast du kein Lager.', en: 'You have no storage in this port.', it: 'In questo porto non hai un magazzino.', fr: 'Vous n’avez pas d’entrepôt dans ce port.', zh: '你在此港没有仓库。', ru: 'В этом порту у вас нет склада.' },
    full: { de: 'Das Lager ist voll.', en: 'The warehouse is full.', it: 'Il magazzino è pieno.', fr: 'L’entrepôt est plein.', zh: '仓库已满。', ru: 'Склад полон.' },
    capacity: { de: 'Kapazität', en: 'Capacity', it: 'Capienza', fr: 'Capacité', zh: '容量', ru: 'Вместимость' },
    rentPerDay: { de: 'Miete je Tag', en: 'Rent per day', it: 'Affitto giornaliero', fr: 'Loyer par jour', zh: '每日租金', ru: 'Аренда в день' },
    deposit: { de: 'Kaution', en: 'Deposit', it: 'Cauzione', fr: 'Caution', zh: '押金', ru: 'Залог' },
    dueAt: { de: 'Fällig am {date}', en: 'Due on {date}', it: 'Scade il {date}', fr: 'Échéance le {date}', zh: '到期日 {date}', ru: 'Срок: {date}' },
    store: { de: 'Einlagern', en: 'Put into store', it: 'Deposita', fr: 'Entreposer', zh: '存入', ru: 'Сдать на склад' },
    load: { de: 'An Bord holen', en: 'Take aboard', it: 'Porta a bordo', fr: 'Embarquer', zh: '取回船上', ru: 'Взять на борт' },
    rented: { de: 'Lager gemietet.', en: 'Storage rented.', it: 'Magazzino affittato.', fr: 'Entrepôt loué.', zh: '仓库已租用。', ru: 'Склад арендован.' },
    arrears: { de: 'Bei fehlender Miete wird Ware im Gegenwert eingezogen.', en: 'Unpaid rent is taken in goods of equal value.', it: 'L’affitto non pagato viene preso in merce di pari valore.', fr: 'Le loyer impayé est prélevé en marchandises de valeur égale.', zh: '欠租将以等值货物抵偿。', ru: 'Неуплаченная аренда взимается товаром на ту же сумму.' },
  },

  rumour: {
    title: { de: 'Gerüchte', en: 'Rumours', it: 'Voci', fr: 'Rumeurs', zh: '传闻', ru: 'Слухи' },
    none: { de: 'In dieser Schenke wird nichts erzählt.', en: 'Nothing is being told in this tavern.', it: 'In questa taverna non si racconta nulla.', fr: 'Rien ne se dit dans cette taverne.', zh: '这家酒馆没什么可听的。', ru: 'В этой таверне ничего не рассказывают.' },
    buy: { de: 'Anhören', en: 'Hear it out', it: 'Ascolta', fr: 'Écouter', zh: '打听', ru: 'Выслушать' },
    bought: { de: 'Das Gerücht steht nun in deiner Karte.', en: 'The rumour is now on your chart.', it: 'La voce è ora sulla tua carta.', fr: 'La rumeur figure maintenant sur votre carte.', zh: '传闻已记入你的海图。', ru: 'Слух занесён в вашу карту.' },
    kinds: {
      price: { de: 'Ein Preis in einem fernen Hafen', en: 'A price in a distant port', it: 'Un prezzo in un porto lontano', fr: 'Un prix dans un port lointain', zh: '远方港口的价格', ru: 'Цена в далёком порту' },
      island: { de: 'Land, das auf keiner Karte steht', en: 'Land that is on no chart', it: 'Una terra che non è su nessuna carta', fr: 'Une terre sur aucune carte', zh: '海图上没有的陆地', ru: 'Земля, которой нет на картах' },
      wreck: { de: 'Ein Wrack, das noch nicht geplündert ist', en: 'A wreck nobody has picked over yet', it: 'Un relitto non ancora saccheggiato', fr: 'Une épave encore intacte', zh: '尚未被搜刮的沉船', ru: 'Ещё не обысканные обломки' },
      danger: { de: 'Was in einem Seegebiet umgeht', en: 'What goes on in a stretch of sea', it: 'Cosa succede in un tratto di mare', fr: 'Ce qui se passe dans un secteur', zh: '某片海域的动静', ru: 'Что творится в одном районе моря' },
      treasure: { de: 'Ein vergrabener Hort', en: 'A buried hoard', it: 'Un tesoro sepolto', fr: 'Un trésor enfoui', zh: '埋藏的宝藏', ru: 'Зарытый клад' },
    },
    confidence: {
      sure: { de: 'Der Erzähler ist sich sicher', en: 'The teller is certain', it: 'Chi parla ne è certo', fr: 'Le conteur en est sûr', zh: '讲述者言之凿凿', ru: 'Рассказчик уверен' },
      likely: { de: 'Klingt glaubwürdig', en: 'Sounds credible', it: 'Sembra credibile', fr: 'Semble crédible', zh: '听着可信', ru: 'Звучит правдоподобно' },
      doubtful: { de: 'Man munkelt nur', en: 'Only hearsay', it: 'Solo dicerie', fr: 'Ce ne sont que des ouï-dire', zh: '只是道听途说', ru: 'Только слухи' },
    },
  },

  treasure: {
    title: { de: 'Schatz', en: 'Treasure', it: 'Tesoro', fr: 'Trésor', zh: '宝藏', ru: 'Клад' },
    here: { de: 'Deine Karte weist genau hierher.', en: 'Your chart points right here.', it: 'La tua carta indica proprio qui.', fr: 'Votre carte indique exactement ici.', zh: '你的海图正指向此处。', ru: 'Ваша карта указывает точно сюда.' },
    dig: { de: 'Ausgraben', en: 'Dig it up', it: 'Dissotterra', fr: 'Déterrer', zh: '挖出来', ru: 'Откопать' },
    found: { de: 'Der Hort ist gehoben!', en: 'The hoard is lifted!', it: 'Il tesoro è dissotterrato!', fr: 'Le trésor est déterré !', zh: '宝藏出土了！', ru: 'Клад поднят!' },
    needSpace: { de: 'Im Frachtraum ist kein Platz für den Hort.', en: 'There is no room in the hold for the hoard.', it: 'Non c’è spazio in stiva per il tesoro.', fr: 'Il n’y a pas de place en cale pour le trésor.', zh: '货舱装不下这批宝藏。', ru: 'В трюме нет места для клада.' },
    chart: { de: 'Kartenwerk', en: 'Charts', it: 'Carte', fr: 'Cartes', zh: '海图', ru: 'Карты' },
    noCharts: { de: 'Du hast noch nichts eingetragen.', en: 'You have charted nothing yet.', it: 'Non hai ancora annotato nulla.', fr: 'Vous n’avez encore rien reporté.', zh: '你还没有记录任何东西。', ru: 'Вы пока ничего не нанесли на карту.' },
  },

  leaderboard: {
    seasons: { de: 'Vergangene Saisons', en: 'Past seasons', it: 'Stagioni passate', fr: 'Saisons passées', zh: '往届赛季', ru: 'Прошлые сезоны' },
    current: { de: 'Laufende Saison', en: 'Current season', it: 'Stagione in corso', fr: 'Saison en cours', zh: '本赛季', ru: 'Текущий сезон' },
    endsIn: { de: 'Endet in {time}', en: 'Ends in {time}', it: 'Termina fra {time}', fr: 'Se termine dans {time}', zh: '{time} 后结束', ru: 'Заканчивается через {time}' },
    closed: { de: 'Abgeschlossen am {date}', en: 'Closed on {date}', it: 'Chiusa il {date}', fr: 'Close le {date}', zh: '于 {date} 结束', ru: 'Завершён {date}' },
    level: { de: 'Stufe', en: 'Level', it: 'Livello', fr: 'Niveau', zh: '等级', ru: 'Уровень' },
    distance: { de: 'Seemeilen', en: 'Distance sailed', it: 'Distanza percorsa', fr: 'Distance parcourue', zh: '航行距离', ru: 'Пройденное расстояние' },
    empty: { de: 'Für diese Saison wurde nichts festgehalten.', en: 'Nothing was recorded for this season.', it: 'Per questa stagione non è stato registrato nulla.', fr: 'Rien n’a été enregistré pour cette saison.', zh: '本赛季没有记录。', ru: 'За этот сезон ничего не записано.' },
  },
};
