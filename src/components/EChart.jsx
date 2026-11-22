import React, { useEffect, useRef } from 'react'
import { echarts } from '../researchChart.js'

/**
 * 通用 ECharts 容器。研究页与 AI 页用 option 全量替换；
 * 训练页需要高频追加数据，可以用 ref 拿到实例后自己调 appendData/setOption。
 */
export const EChart = React.forwardRef(function EChart({ option, height = 620 }, ref) {
  const elRef = useRef(null)
  const instRef = useRef(null)

  useEffect(() => {
    instRef.current = echarts.init(elRef.current)
    if (ref) {
      if (typeof ref === 'function') ref(instRef.current)
      else ref.current = instRef.current
    }
    const onResize = () => instRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      instRef.current?.dispose()
      instRef.current = null
      if (ref && typeof ref !== 'function') ref.current = null
    }
  }, [ref])

  useEffect(() => {
    instRef.current?.setOption(option, true)
  }, [option])

  return <div className="chart" style={{ height }} ref={elRef} />
})
