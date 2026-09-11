/** The tutorial's steps, each phrased as the thing to go and do. */
export default {
  tutorial: {
    subtitle: {
      de: 'Acht Handgriffe, und du bist Kaufmann. Jeder Schritt gilt erst, wenn du ihn wirklich getan hast.',
      en: 'Eight things to do, and you are a merchant. A step only counts once you have really done it.',
      it: 'Otto cose da fare e sei un mercante. Un passo vale solo quando l’hai davvero fatto.',
      fr: 'Huit gestes et vous voilà marchand. Une étape ne compte qu’une fois réellement accomplie.',
      zh: '八件事做完，你就是商人了。每一步只有真正做到才算数。',
      ru: 'Восемь дел — и вы купец. Шаг засчитывается, только когда он действительно сделан.',
    },
    progress: { de: '{done} von {total} erledigt', en: '{done} of {total} done', it: '{done} di {total} completati', fr: '{done} sur {total} accomplies', zh: '已完成 {done} / {total}', ru: 'Выполнено {done} из {total}' },
    resume: { de: 'Tutorial fortsetzen', en: 'Resume the tutorial', it: 'Riprendi il tutorial', fr: 'Reprendre le tutoriel', zh: '继续教程', ru: 'Продолжить обучение' },
    hide: { de: 'Ausblenden', en: 'Hide', it: 'Nascondi', fr: 'Masquer', zh: '隐藏', ru: 'Скрыть' },
    finished: {
      de: 'Geschafft. Der Rest des Meeres gehört dir.',
      en: 'Done. The rest of the sea is yours.',
      it: 'Fatto. Il resto del mare è tuo.',
      fr: 'C’est fait. Le reste de la mer est à vous.',
      zh: '完成了。剩下的海洋属于你。',
      ru: 'Готово. Остальное море — ваше.',
    },
      /*
       * Short imperative labels, not how-to prose - the full explanation
       * (including how steering actually works) lives in the docs now, so a
       * control scheme change here never needs a rewrite of this checklist.
       */
    steps: {
      move: {
        de: 'Kurs setzen und ablegen',
        en: 'Set a course and cast off',
        it: 'Traccia una rotta e salpa',
        fr: 'Tracez un cap et larguez les amarres',
        zh: '设定航向并起航',
        ru: 'Проложите курс и отчальте',
      },
      buy: {
        de: 'Eine Ware im Hafen kaufen',
        en: 'Buy a commodity in port',
        it: 'Compra una merce in porto',
        fr: 'Achetez une marchandise au port',
        zh: '在港口买入一种货物',
        ru: 'Купите товар в порту',
      },
      sail: {
        de: 'Aufs offene Meer hinausfahren',
        en: 'Head out to open water',
        it: 'Prendi il largo',
        fr: 'Gagnez le large',
        zh: '驶向开阔海域',
        ru: 'Выйдите в открытое море',
      },
      dock: {
        de: 'In einem zweiten Hafen anlegen',
        en: 'Dock at a second port',
        it: 'Attracca in un secondo porto',
        fr: 'Accostez dans un deuxième port',
        zh: '在第二个港口停靠',
        ru: 'Причальте во втором порту',
      },
      sell: {
        de: 'Die Ladung verkaufen',
        en: 'Sell your cargo',
        it: 'Vendi il carico',
        fr: 'Vendez votre cargaison',
        zh: '卖出货物',
        ru: 'Продайте груз',
      },
      crew: {
        de: 'Einen zweiten Mann anheuern',
        en: 'Hire a second hand',
        it: 'Assumi un secondo uomo',
        fr: 'Engagez un second matelot',
        zh: '再雇一名船员',
        ru: 'Наймите второго матроса',
      },
      contract: {
        de: 'Einen Auftrag von der Tafel annehmen',
        en: 'Take a contract from the board',
        it: 'Accetta un incarico dalla bacheca',
        fr: 'Prenez un contrat au tableau',
        zh: '从告示板接一个委托',
        ru: 'Возьмите поручение с доски',
      },
      deliver: {
        de: 'Den Auftrag abliefern',
        en: 'Deliver the contract',
        it: 'Consegna l’incarico',
        fr: 'Livrez le contrat',
        zh: '完成委托交付',
        ru: 'Сдайте поручение',
      },
    },
  },
};
