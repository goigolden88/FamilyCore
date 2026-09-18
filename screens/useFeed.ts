/**
 * Данные ленты: все хранилища разом. Взято из «Дневников».
 *
 * Лента только читает, поэтому общего состояния с модулями ей не нужно:
 * она берёт слепок базы и перечитывает его на любое изменение — своё,
 * чужое, из файла. Слепок, а не выборка по хранилищу: он отдаёт записи
 * вместе с надгробиями, а без них у блока удалённой категории не было бы
 * имени.
 */

import { useEffect, useMemo, useState } from 'react'
import { db } from '../core/db.ts'
import { today, type DateStr } from '../core/dates.ts'
import type { FeedItem } from '../core/feed.ts'
import { feedItems, type Data } from '../registry.ts'

export type Feed = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  items: FeedItem[]
}

export function useFeed(): Feed {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [day, setDay] = useState<DateStr>(today())

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        await db.ready()
        const snapshot = await db.exportAll()
        if (!cancelled) setData(snapshot.data)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Неизвестная ошибка')
      }
    }

    void load()
    const unsubscribe = db.onChange(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Строки вправе зависеть от сегодняшнего дня, а вкладка установленного
  // приложения неделями не перезапускается.
  useEffect(() => {
    function refreshDay() {
      if (document.visibilityState === 'visible') setDay(today())
    }
    document.addEventListener('visibilitychange', refreshDay)
    return () => document.removeEventListener('visibilitychange', refreshDay)
  }, [])

  const items = useMemo(() => (data ? feedItems(data, day) : []), [data, day])

  return {
    status: error ? 'failed' : data ? 'ready' : 'loading',
    error,
    items,
  }
}
