import { reactive } from 'vue'
import type { TablePaginationConfig } from 'ant-design-vue'

const defaultPageSizeOptions = ['8', '10', '20', '50', '100']

export function createTablePagination(
  pageSize: number,
  pageSizeOptions: string[] = defaultPageSizeOptions,
): TablePaginationConfig {
  const pagination = reactive<TablePaginationConfig>({
    current: 1,
    pageSize,
    pageSizeOptions,
    showLessItems: true,
    showSizeChanger: true,
    showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
    size: 'small',
  })

  pagination.onChange = (page, nextPageSize) => {
    pagination.current = page
    pagination.pageSize = nextPageSize
  }

  pagination.onShowSizeChange = (_current, nextPageSize) => {
    pagination.current = 1
    pagination.pageSize = nextPageSize
  }

  return pagination
}
